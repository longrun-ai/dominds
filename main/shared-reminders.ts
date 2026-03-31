import type { ReminderSnapshotItem } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AsyncFifoMutex } from './runtime/async-fifo-mutex';
import {
  cloneReminder,
  compareReminderDisplayOrder,
  materializeReminder,
  type Reminder,
} from './tool';
import { getReminderOwner } from './tools/registry';

const sharedReminderLocks = new Map<string, AsyncFifoMutex>();

function getSharedReminderLock(agentId: string): AsyncFifoMutex {
  const existing = sharedReminderLocks.get(agentId);
  if (existing) return existing;
  const created = new AsyncFifoMutex();
  sharedReminderLocks.set(agentId, created);
  return created;
}

function getSharedReminderDirPath(agentId: string): string {
  return path.resolve(process.cwd(), '.dialogs', 'reminders', agentId);
}

function ensureReminderIdPathSegment(reminderId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(reminderId)) {
    throw new Error(`Unsafe reminder_id for shared reminder storage: ${reminderId}`);
  }
  return reminderId;
}

function getSharedReminderFilePath(agentId: string, reminderId: string): string {
  return path.join(
    getSharedReminderDirPath(agentId),
    `${ensureReminderIdPathSegment(reminderId)}.json`,
  );
}

function serializeReminder(reminder: Reminder): ReminderSnapshotItem {
  return {
    id: reminder.id,
    content: reminder.content,
    // Persist only the stable owner route key. The framework must not peek into owner
    // metadata to "rediscover" which owner should handle this reminder.
    ownerName: reminder.owner?.name,
    meta: reminder.meta,
    echoback: reminder.echoback,
    scope: reminder.scope ?? 'agent_shared',
    createdAt: reminder.createdAt ?? formatUnifiedTimestamp(new Date()),
    priority: reminder.priority ?? 'medium',
  };
}

function materializeStoredReminder(snapshot: ReminderSnapshotItem): Reminder {
  const ownerName = typeof snapshot.ownerName === 'string' ? snapshot.ownerName : undefined;
  // Unknown owners are preserved as ownerless opaque reminders rather than guessed from meta.
  const owner = ownerName ? getReminderOwner(ownerName) : undefined;
  return materializeReminder({
    id: snapshot.id,
    content: snapshot.content,
    owner,
    meta: snapshot.meta,
    echoback: snapshot.echoback,
    scope: snapshot.scope ?? 'agent_shared',
    createdAt: snapshot.createdAt,
    priority: snapshot.priority,
  });
}

function cloneReminderList(reminders: readonly Reminder[]): Reminder[] {
  return reminders.map((reminder) => cloneReminder(reminder));
}

async function writeReminderSnapshotFile(
  filePath: string,
  snapshot: ReminderSnapshotItem,
): Promise<void> {
  const json = JSON.stringify(snapshot, null, 2);
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempFile, json, 'utf-8');
  await fs.rename(tempFile, filePath);
}

async function listPerReminderJsonFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);
}

async function readSharedRemindersUnlocked(agentId: string): Promise<Reminder[]> {
  const dirPath = getSharedReminderDirPath(agentId);
  let fileNames: string[];
  try {
    fileNames = await listPerReminderJsonFiles(dirPath);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const reminders = await Promise.all(
    fileNames.map(async (fileName) => {
      const raw = await fs.readFile(path.join(dirPath, fileName), 'utf-8');
      return materializeStoredReminder(JSON.parse(raw) as ReminderSnapshotItem);
    }),
  );
  reminders.sort(compareReminderDisplayOrder);
  return reminders;
}

async function writeSharedRemindersUnlocked(
  agentId: string,
  reminders: readonly Reminder[],
): Promise<void> {
  const dirPath = getSharedReminderDirPath(agentId);
  await fs.mkdir(dirPath, { recursive: true });

  const existingFileNames = await listPerReminderJsonFiles(dirPath);
  const desiredIds = new Set<string>();
  for (const reminder of reminders) {
    if (desiredIds.has(reminder.id)) {
      throw new Error(
        `Duplicate shared reminder_id detected while persisting agent ${agentId}: ${reminder.id}`,
      );
    }
    desiredIds.add(reminder.id);
  }

  await Promise.all(
    existingFileNames
      .filter((fileName) => !desiredIds.has(fileName.slice(0, -'.json'.length)))
      .map((fileName) => fs.unlink(path.join(dirPath, fileName))),
  );

  await Promise.all(
    reminders.map((reminder) =>
      writeReminderSnapshotFile(
        getSharedReminderFilePath(agentId, reminder.id),
        serializeReminder(reminder),
      ),
    ),
  );
}

export async function loadAgentSharedReminders(agentId: string): Promise<Reminder[]> {
  const release = await getSharedReminderLock(agentId).acquire();
  try {
    return cloneReminderList(await readSharedRemindersUnlocked(agentId));
  } finally {
    release();
  }
}

export async function replaceAgentSharedReminders(
  agentId: string,
  reminders: readonly Reminder[],
): Promise<void> {
  const release = await getSharedReminderLock(agentId).acquire();
  try {
    await writeSharedRemindersUnlocked(agentId, reminders);
  } finally {
    release();
  }
}

export async function mutateAgentSharedReminders<T>(
  agentId: string,
  mutate: (reminders: Reminder[]) => Promise<T> | T,
): Promise<T> {
  const release = await getSharedReminderLock(agentId).acquire();
  try {
    const reminders = await readSharedRemindersUnlocked(agentId);
    const result = await mutate(reminders);
    await writeSharedRemindersUnlocked(agentId, reminders);
    return result;
  } finally {
    release();
  }
}
