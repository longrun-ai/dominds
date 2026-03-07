import type { AppsHostClient, EnabledAppForHost } from '../apps-host/client';
import type {
  DomindsAppReminderApplyRequest,
  DomindsAppReminderOwnerJson,
  DomindsAppReminderState,
} from '../apps/app-json';
import type { Dialog } from '../dialog';
import { postDialogEvent } from '../evt-registry';
import type { ChatMessage } from '../llm/client';
import { formatReminderItemGuide } from '../shared/i18n/driver-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import type { FullRemindersEvent, ReminderContent } from '../shared/types/dialog';
import {
  computeReminderNoByIndex,
  reminderEchoBackEnabled,
  type JsonValue,
  type Reminder,
  type ReminderOwner,
  type ReminderUpdateResult,
} from '../tool';

import { getReminderOwner, registerReminderOwner } from './registry';

type AppReminderOwnerDescriptor = Readonly<{
  appId: string;
  ownerRef: string;
  registryName: string;
  managedByTool: string;
  source: string;
  updateExample: string;
}>;

type AppReminderMeta = Readonly<{
  kind: 'app_reminder_owner';
  appId: string;
  ownerRef: string;
  managedByTool: string;
  source: string;
  updateExample: string;
}>;

const APP_REMINDER_META_KEYS = new Set([
  'kind',
  'appId',
  'ownerRef',
  'managedByTool',
  'source',
  'updateExample',
  'ownerMeta',
]);

const appReminderDescriptors = new Map<string, AppReminderOwnerDescriptor>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAppReminderMeta(value: unknown): value is AppReminderMeta {
  if (!isRecord(value)) return false;
  if (value['kind'] !== 'app_reminder_owner') return false;
  if (typeof value['appId'] !== 'string' || value['appId'].trim() === '') return false;
  if (typeof value['ownerRef'] !== 'string' || value['ownerRef'].trim() === '') return false;
  if (typeof value['managedByTool'] !== 'string' || value['managedByTool'].trim() === '')
    return false;
  if (typeof value['source'] !== 'string' || value['source'].trim() === '') return false;
  if (typeof value['updateExample'] !== 'string' || value['updateExample'].trim() === '')
    return false;
  return true;
}

function normalizeInsertPosition(remindersLength: number, position: number | undefined): number {
  if (position === undefined) return remindersLength;
  if (!Number.isFinite(position)) return remindersLength;
  const normalized = Math.floor(position);
  if (normalized <= 0) return 0;
  if (normalized >= remindersLength) return remindersLength;
  return normalized;
}

function toManagedByTool(owner: DomindsAppReminderOwnerJson): string {
  const managedByTool = owner.managedByTool?.trim();
  if (managedByTool && managedByTool.length > 0) return managedByTool;
  return owner.ref;
}

function toUpdateExample(owner: DomindsAppReminderOwnerJson): string {
  const updateExample = owner.updateExample?.trim();
  if (updateExample && updateExample.length > 0) return updateExample;
  return `${toManagedByTool(owner)}({ ... })`;
}

function buildDescriptor(params: {
  appId: string;
  owner: DomindsAppReminderOwnerJson;
}): AppReminderOwnerDescriptor {
  return {
    appId: params.appId,
    ownerRef: params.owner.ref,
    registryName: buildAppReminderOwnerRegistryName(params.appId, params.owner.ref),
    managedByTool: toManagedByTool(params.owner),
    source: toManagedByTool(params.owner),
    updateExample: toUpdateExample(params.owner),
  };
}

function buildAppReminderMeta(
  descriptor: AppReminderOwnerDescriptor,
  ownerMeta: JsonValue | undefined,
): AppReminderMeta & Record<string, JsonValue> {
  const baseMeta: AppReminderMeta = {
    kind: 'app_reminder_owner',
    appId: descriptor.appId,
    ownerRef: descriptor.ownerRef,
    managedByTool: descriptor.managedByTool,
    source: descriptor.source,
    updateExample: descriptor.updateExample,
  };
  if (isJsonRecord(ownerMeta)) {
    return { ...ownerMeta, ...baseMeta };
  }
  if (ownerMeta !== undefined) {
    return { ...baseMeta, ownerMeta };
  }
  return baseMeta;
}

function extractOwnerMeta(meta: JsonValue | undefined): JsonValue | undefined {
  if (!isJsonRecord(meta)) {
    return undefined;
  }
  const payloadEntries = Object.entries(meta).filter(([key]) => !APP_REMINDER_META_KEYS.has(key));
  if (payloadEntries.length > 0) {
    return Object.fromEntries(payloadEntries);
  }
  return meta['ownerMeta'];
}

function toReminderState(reminder: Reminder): DomindsAppReminderState {
  return {
    content: reminder.content,
    meta: extractOwnerMeta(reminder.meta),
    echoback: reminder.echoback,
  };
}

function findOwnedReminderEntries(
  dlg: Dialog,
  descriptor: AppReminderOwnerDescriptor,
  owner: ReminderOwner,
): Array<Readonly<{ index: number; reminder: Reminder }>> {
  const entries: Array<Readonly<{ index: number; reminder: Reminder }>> = [];
  for (let index = 0; index < dlg.reminders.length; index += 1) {
    const reminder = dlg.reminders[index];
    if (!reminder || reminder.owner !== owner || !isAppReminderMeta(reminder.meta)) {
      continue;
    }
    if (
      reminder.meta.appId !== descriptor.appId ||
      reminder.meta.ownerRef !== descriptor.ownerRef
    ) {
      continue;
    }
    entries.push({ index, reminder });
  }
  return entries;
}

function fallbackRenderedReminder(reminder: Reminder, reminderNo: number): ChatMessage {
  const language = getWorkLanguage();
  return {
    type: 'transient_guide_msg',
    role: 'assistant',
    content: formatReminderItemGuide(language, reminderNo, reminder.content, {
      meta: reminder.meta,
    }),
  };
}

async function persistAndPublishReminders(dlg: Dialog): Promise<void> {
  await dlg.dlgStore.persistReminders(dlg, dlg.reminders);
  const reminderNoByIndex = computeReminderNoByIndex(dlg.reminders);
  const reminders: ReminderContent[] = dlg.reminders.map((reminder, index) => ({
    content: reminder.content,
    meta: isRecord(reminder.meta) ? reminder.meta : undefined,
    reminder_no: reminderNoByIndex.get(index),
    echoback: reminderEchoBackEnabled(reminder),
  }));
  const evt: FullRemindersEvent = { type: 'full_reminders_update', reminders };
  postDialogEvent(dlg, evt);
}

function createAppReminderOwner(params: {
  descriptor: AppReminderOwnerDescriptor;
  resolveHostClient: () => AppsHostClient;
}): ReminderOwner {
  const { descriptor, resolveHostClient } = params;

  const owner: ReminderOwner = {
    name: descriptor.registryName,
    async updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult> {
      if (reminder.owner !== owner || !isAppReminderMeta(reminder.meta)) {
        return { treatment: 'keep' };
      }
      try {
        const client = resolveHostClient();
        const result = await client.updateReminder(descriptor.appId, descriptor.ownerRef, {
          dialogId: dlg.id.selfId,
          reminder: toReminderState(reminder),
        });
        if (result.treatment !== 'update') {
          return result;
        }
        return {
          treatment: 'update',
          updatedContent: result.updatedContent ?? reminder.content,
          updatedMeta:
            result.updatedMeta !== undefined
              ? buildAppReminderMeta(descriptor, result.updatedMeta)
              : reminder.meta,
        };
      } catch {
        return { treatment: 'keep' };
      }
    },
    async renderReminder(dlg: Dialog, reminder: Reminder, index: number): Promise<ChatMessage> {
      if (reminder.owner !== owner || !isAppReminderMeta(reminder.meta)) {
        return fallbackRenderedReminder(reminder, index + 1);
      }
      try {
        const client = resolveHostClient();
        return await client.renderReminder(descriptor.appId, descriptor.ownerRef, {
          dialogId: dlg.id.selfId,
          reminder: toReminderState(reminder),
          reminderNo: index + 1,
          workLanguage: getWorkLanguage(),
        });
      } catch {
        return fallbackRenderedReminder(reminder, index + 1);
      }
    },
  };

  return owner;
}

export function buildAppReminderOwnerRegistryName(appId: string, ownerRef: string): string {
  return `app/${appId}/${ownerRef}`;
}

export function ensureAppReminderOwnersRegistered(params: {
  enabledApps: ReadonlyArray<EnabledAppForHost>;
  resolveHostClient: () => AppsHostClient;
}): void {
  for (const app of params.enabledApps) {
    const reminderOwners = app.installJson.contributes?.reminderOwners ?? [];
    const seenOwnerRefs = new Set<string>();
    for (const owner of reminderOwners) {
      if (seenOwnerRefs.has(owner.ref)) {
        throw new Error(`App '${app.appId}' declares duplicate reminder owner ref '${owner.ref}'`);
      }
      seenOwnerRefs.add(owner.ref);
      const descriptor = buildDescriptor({ appId: app.appId, owner });
      appReminderDescriptors.set(descriptor.registryName, descriptor);
      if (getReminderOwner(descriptor.registryName)) {
        continue;
      }
      registerReminderOwner(
        createAppReminderOwner({ descriptor, resolveHostClient: params.resolveHostClient }),
      );
    }
  }
}

export async function applyAppReminderRequests(
  dlg: Dialog,
  params: {
    appId: string;
    reminderRequests: ReadonlyArray<DomindsAppReminderApplyRequest>;
    resolveHostClient: () => AppsHostClient;
  },
): Promise<void> {
  const client = params.resolveHostClient();
  let changed = false;

  for (const request of params.reminderRequests) {
    const registryName = buildAppReminderOwnerRegistryName(params.appId, request.ownerRef);
    const descriptor = appReminderDescriptors.get(registryName);
    const owner = getReminderOwner(registryName);
    if (!descriptor || !owner) {
      throw new Error(
        `App '${params.appId}' attempted to use unregistered reminder owner '${request.ownerRef}'`,
      );
    }

    const ownedEntries = findOwnedReminderEntries(dlg, descriptor, owner);
    const result = await client.applyReminder(params.appId, request.ownerRef, request, {
      dialogId: dlg.id.selfId,
      ownedReminders: ownedEntries.map((entry) => toReminderState(entry.reminder)),
    });

    switch (result.treatment) {
      case 'noop':
        break;
      case 'add': {
        dlg.addReminder(
          result.reminder.content,
          owner,
          buildAppReminderMeta(descriptor, result.reminder.meta),
          normalizeInsertPosition(dlg.reminders.length, result.position),
          { echoback: result.reminder.echoback },
        );
        changed = true;
        break;
      }
      case 'update': {
        const target = ownedEntries[result.ownedIndex];
        if (!target) {
          throw new Error(
            `App '${params.appId}' reminder owner '${request.ownerRef}' returned invalid ownedIndex=${result.ownedIndex}`,
          );
        }
        dlg.updateReminder(
          target.index,
          result.reminder.content,
          buildAppReminderMeta(descriptor, result.reminder.meta),
          { echoback: result.reminder.echoback },
        );
        changed = true;
        break;
      }
      case 'delete': {
        const target = ownedEntries[result.ownedIndex];
        if (!target) {
          throw new Error(
            `App '${params.appId}' reminder owner '${request.ownerRef}' returned invalid ownedIndex=${result.ownedIndex}`,
          );
        }
        dlg.deleteReminder(target.index);
        changed = true;
        break;
      }
      default: {
        const _exhaustive: never = result;
        throw new Error(`Unsupported app reminder apply result: ${String(_exhaustive)}`);
      }
    }
  }

  if (changed) {
    await persistAndPublishReminders(dlg);
  }
}
