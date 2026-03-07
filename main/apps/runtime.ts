import { Dialog, DialogID, RootDialog, SubDialog } from '../dialog';
import { globalDialogRegistry } from '../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../dialog-instance-registry';
import { createLogger } from '../log';
import type { I18nText } from '../shared/types/i18n';
import type { Tool } from '../tool';
import {
  applyAppReminderRequests,
  ensureAppReminderOwnersRegistered,
} from '../tools/app-reminders';
import {
  getTool,
  getToolset,
  registerTool,
  registerToolset,
  setToolsetMeta,
} from '../tools/registry';
import type { DomindsAppDialogReminderRequestBatch, DomindsAppDialogTargetRef } from './app-json';

import { startAppsHost, type AppsHostClient, type EnabledAppForHost } from '../apps-host/client';
import { registerAppDialogRunControl } from './dialog-run-controls';
import { loadEnabledAppsSnapshot } from './enabled-apps';
import { reconcileAppsResolutionIssuesToProblems } from './problems';

const log = createLogger('apps-runtime');

let appsHostClient: AppsHostClient | null = null;
const proxyRegisteredAppIds = new Set<string>();

function resolveRootDialogFor(dlg: Dialog): RootDialog {
  if (dlg instanceof RootDialog) {
    return dlg;
  }
  if (dlg instanceof SubDialog) {
    return dlg.rootDialog;
  }
  throw new Error(`Unsupported dialog type for app runtime: ${dlg.constructor.name}`);
}

async function ensureRootDialogLoaded(rootId: string): Promise<RootDialog | undefined> {
  const existing = globalDialogRegistry.get(rootId);
  if (existing) {
    await existing.loadSubdialogRegistry();
    await existing.loadPendingSubdialogsFromPersistence();
    return existing;
  }
  return await getOrRestoreRootDialog(rootId, 'running');
}

async function ensureDialogLoadedBySelfId(
  rootDialog: RootDialog,
  dialogSelfId: string,
): Promise<Dialog | undefined> {
  if (dialogSelfId === rootDialog.id.rootId) {
    return rootDialog;
  }
  const existing = rootDialog.lookupDialog(dialogSelfId);
  if (existing) {
    return existing;
  }
  return await ensureDialogLoaded(
    rootDialog,
    new DialogID(dialogSelfId, rootDialog.id.rootId),
    'running',
  );
}

function describeTarget(target: DomindsAppDialogTargetRef): string {
  if ('dialogId' in target) {
    return `dialogId=${target.dialogId}`;
  }
  const parts = [`agentId=${target.agentId}`];
  if (target.rootDialogId) {
    parts.push(`rootDialogId=${target.rootDialogId}`);
  }
  if (target.sessionSlug) {
    parts.push(`sessionSlug=${target.sessionSlug}`);
  }
  return parts.join(' ');
}

async function resolveTargetDialog(
  sourceDlg: Dialog,
  target: DomindsAppDialogTargetRef,
): Promise<Dialog> {
  const sourceRoot = resolveRootDialogFor(sourceDlg);
  if ('dialogId' in target) {
    const matches: Dialog[] = [];
    const seenDialogKeys = new Set<string>();
    const pushMatch = (dialog: Dialog | undefined): void => {
      if (!dialog) return;
      const key = dialog.id.valueOf();
      if (seenDialogKeys.has(key)) return;
      seenDialogKeys.add(key);
      matches.push(dialog);
    };

    pushMatch(await ensureDialogLoadedBySelfId(sourceRoot, target.dialogId));
    for (const loadedRoot of globalDialogRegistry.getAll()) {
      pushMatch(await ensureDialogLoadedBySelfId(loadedRoot, target.dialogId));
    }
    if (target.dialogId !== sourceRoot.id.rootId) {
      pushMatch(await ensureRootDialogLoaded(target.dialogId));
    }

    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length === 0) {
      throw new Error(`dialog reminder target not found (${describeTarget(target)})`);
    }
    throw new Error(`dialog reminder target is ambiguous (${describeTarget(target)})`);
  }

  const targetRootId = target.rootDialogId ?? sourceRoot.id.rootId;
  const targetRoot =
    targetRootId === sourceRoot.id.rootId ? sourceRoot : await ensureRootDialogLoaded(targetRootId);
  if (!targetRoot) {
    throw new Error(`dialog reminder target root not found (${describeTarget(target)})`);
  }

  await targetRoot.loadSubdialogRegistry();
  await targetRoot.loadPendingSubdialogsFromPersistence();

  if (target.sessionSlug) {
    const subdialog = targetRoot.lookupSubdialog(target.agentId, target.sessionSlug);
    if (!subdialog) {
      throw new Error(`dialog reminder target not found (${describeTarget(target)})`);
    }
    return subdialog;
  }

  const matches = targetRoot.getAllDialogs().filter((dialog) => dialog.agentId === target.agentId);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    throw new Error(`dialog reminder target not found (${describeTarget(target)})`);
  }
  throw new Error(`dialog reminder target is ambiguous (${describeTarget(target)})`);
}

async function applyDialogReminderRequestBatches(
  sourceDlg: Dialog,
  appId: string,
  dialogReminderRequests: ReadonlyArray<DomindsAppDialogReminderRequestBatch>,
): Promise<void> {
  for (const batch of dialogReminderRequests) {
    if (batch.reminderRequests.length === 0) {
      continue;
    }
    const targetDlg = await resolveTargetDialog(sourceDlg, batch.target);
    await applyAppReminderRequests(targetDlg, {
      appId,
      reminderRequests: batch.reminderRequests,
      resolveHostClient: getAppsHostClient,
    });
  }
}

export function getAppsHostClient(): AppsHostClient {
  if (!appsHostClient) {
    throw new Error('Apps host is not initialized');
  }
  return appsHostClient;
}

export async function shutdownAppsRuntime(): Promise<void> {
  const client = appsHostClient;
  if (!client) return;
  appsHostClient = null;
  await client.shutdown();
}

function ensureNoDuplicateTool(toolName: string, appId: string): void {
  const existing = getTool(toolName);
  if (existing) {
    throw new Error(`App '${appId}' attempted to register duplicate tool '${toolName}'`);
  }
}

function ensureNoDuplicateToolset(toolsetId: string, appId: string): void {
  const existing = getToolset(toolsetId);
  if (existing) {
    throw new Error(`App '${appId}' attempted to register duplicate toolset '${toolsetId}'`);
  }
}

function registerAppToolset(params: {
  appId: string;
  toolsetId: string;
  tools: Tool[];
  descriptionI18n?: I18nText;
}): void {
  ensureNoDuplicateToolset(params.toolsetId, params.appId);
  for (const t of params.tools) ensureNoDuplicateTool(t.name, params.appId);
  for (const t of params.tools) registerTool(t);
  registerToolset(params.toolsetId, params.tools);
  setToolsetMeta(params.toolsetId, { source: 'app', descriptionI18n: params.descriptionI18n });
}

function registerAppProxyToolsForEnabledApps(params: {
  enabledApps: ReadonlyArray<EnabledAppForHost>;
}): void {
  for (const app of params.enabledApps) {
    if (proxyRegisteredAppIds.has(app.appId)) continue;
    const toolsets = app.installJson.contributes?.toolsets ?? [];
    for (const ts of toolsets) {
      const tools: Tool[] = ts.tools.map((t) => ({
        type: 'func',
        name: t.name,
        description: t.description,
        descriptionI18n: t.descriptionI18n,
        parameters: t.parameters,
        call: async (dlg, caller, args) => {
          const host = getAppsHostClient();
          const result = await host.callTool(t.name, args, {
            dialogId: dlg.id.selfId,
            rootDialogId: dlg.id.rootId,
            agentId: dlg.agentId,
            sessionSlug: dlg instanceof SubDialog ? dlg.sessionSlug : undefined,
            callerId: caller.id,
          });
          if (Array.isArray(result.reminderRequests) && result.reminderRequests.length > 0) {
            await applyAppReminderRequests(dlg, {
              appId: app.appId,
              reminderRequests: result.reminderRequests,
              resolveHostClient: getAppsHostClient,
            });
          }
          if (
            Array.isArray(result.dialogReminderRequests) &&
            result.dialogReminderRequests.length > 0
          ) {
            await applyDialogReminderRequestBatches(dlg, app.appId, result.dialogReminderRequests);
          }
          return result.output;
        },
      }));
      registerAppToolset({
        appId: app.appId,
        toolsetId: ts.id,
        tools,
        descriptionI18n: ts.descriptionI18n,
      });
    }
    proxyRegisteredAppIds.add(app.appId);
  }
}

function registerAppDialogRunControlsForEnabledApps(params: {
  enabledApps: ReadonlyArray<EnabledAppForHost>;
}): void {
  for (const app of params.enabledApps) {
    const controls = app.installJson.contributes?.dialogRunControls ?? [];
    for (const control of controls) {
      registerAppDialogRunControl({
        id: control.id,
        appId: app.appId,
        descriptionI18n: control.descriptionI18n,
      });
    }
  }
}

export async function registerEnabledAppsToolProxies(params: {
  rtwsRootAbs: string;
}): Promise<void> {
  const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: params.rtwsRootAbs });
  reconcileAppsResolutionIssuesToProblems({ issues: snapshot.issues });
  const enabledApps: EnabledAppForHost[] = snapshot.enabledApps.map((a) => ({
    appId: a.id,
    runtimePort: a.runtimePort,
    installJson: a.installJson,
  }));
  if (enabledApps.length === 0) return;
  registerAppProxyToolsForEnabledApps({ enabledApps });
  ensureAppReminderOwnersRegistered({
    enabledApps,
    resolveHostClient: getAppsHostClient,
  });
}

export async function initAppsRuntime(params: {
  rtwsRootAbs: string;
  kernel: Readonly<{ host: string; port: number }>;
}): Promise<void> {
  if (appsHostClient) {
    throw new Error('Apps runtime already initialized');
  }

  const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: params.rtwsRootAbs });
  reconcileAppsResolutionIssuesToProblems({ issues: snapshot.issues });
  const enabledApps: EnabledAppForHost[] = snapshot.enabledApps.map((a) => ({
    appId: a.id,
    runtimePort: a.runtimePort,
    installJson: a.installJson,
  }));

  if (enabledApps.length === 0) {
    log.info('No enabled apps');
    return;
  }

  // Register proxy tools first (fail fast on collisions) so team loading/validation can see toolsets.
  registerAppProxyToolsForEnabledApps({ enabledApps });
  // Register dialog run controls before websocket handlers start processing user drives.
  registerAppDialogRunControlsForEnabledApps({ enabledApps });

  log.info(`Starting apps-host (${enabledApps.length} enabled apps)`);
  const { client } = await startAppsHost({
    rtwsRootAbs: params.rtwsRootAbs,
    kernel: params.kernel,
    apps: enabledApps,
  });
  appsHostClient = client;
  ensureAppReminderOwnersRegistered({
    enabledApps,
    resolveHostClient: getAppsHostClient,
  });
}
