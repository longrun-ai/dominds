import type { ReminderSnapshotItem } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { crc32 } from 'zlib';
import { AsyncFifoMutex } from './runtime/async-fifo-mutex';
import {
  cloneReminder,
  compareReminderDisplayOrder,
  materializeReminder,
  type Reminder,
} from './tool';
import { getReminderOwner } from './tools/registry';

const sharedReminderLocks = new Map<string, AsyncFifoMutex>();

export type SharedReminderTarget =
  | Readonly<{
      kind: 'agent';
      agentId: string;
    }>
  | Readonly<{
      kind: 'task';
      agentId: string;
      taskDocPath: string;
    }>;

function getSharedReminderTargetKey(target: SharedReminderTarget): string {
  switch (target.kind) {
    case 'agent':
      return `agent:${target.agentId}`;
    case 'task':
      return `task:${target.agentId}:${target.taskDocPath}`;
  }
  const _exhaustive: never = target;
  return _exhaustive;
}

function getSharedReminderLock(target: SharedReminderTarget): AsyncFifoMutex {
  const key = getSharedReminderTargetKey(target);
  const existing = sharedReminderLocks.get(key);
  if (existing) return existing;
  const created = new AsyncFifoMutex();
  sharedReminderLocks.set(key, created);
  return created;
}

function clearSharedReminderLockIfIdle(target: SharedReminderTarget, lock: AsyncFifoMutex): void {
  const key = getSharedReminderTargetKey(target);
  if (sharedReminderLocks.get(key) === lock && !lock.isLocked()) {
    sharedReminderLocks.delete(key);
  }
}

function getTaskDocPathStorageKey(taskDocPath: string): string {
  const normalized = taskDocPath.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (normalized === '') {
    throw new Error('task-scoped reminders require a non-empty taskDocPath');
  }
  const checksum = crc32(normalized) >>> 0;
  return `crc32-${checksum.toString(16).padStart(8, '0')}`;
}

function getSharedReminderDirPath(target: SharedReminderTarget): string {
  switch (target.kind) {
    case 'agent':
      return path.resolve(process.cwd(), '.dialogs', 'reminders', 'agents', target.agentId);
    case 'task':
      return path.resolve(
        process.cwd(),
        '.dialogs',
        'reminders',
        'agent_tasks',
        target.agentId,
        getTaskDocPathStorageKey(target.taskDocPath),
      );
  }
  const _exhaustive: never = target;
  return _exhaustive;
}

function ensureReminderIdPathSegment(reminderId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(reminderId)) {
    throw new Error(`Unsafe reminder_id for shared reminder storage: ${reminderId}`);
  }
  return reminderId;
}

function getSharedReminderFilePath(target: SharedReminderTarget, reminderId: string): string {
  return path.join(
    getSharedReminderDirPath(target),
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
    scope: reminder.scope ?? 'agent',
    renderMode: reminder.renderMode ?? 'markdown',
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
    scope: snapshot.scope ?? 'agent',
    renderMode: snapshot.renderMode ?? 'markdown',
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

async function readSharedRemindersUnlocked(target: SharedReminderTarget): Promise<Reminder[]> {
  const dirPath = getSharedReminderDirPath(target);
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
  target: SharedReminderTarget,
  reminders: readonly Reminder[],
): Promise<void> {
  const dirPath = getSharedReminderDirPath(target);
  await fs.mkdir(dirPath, { recursive: true });

  const existingFileNames = await listPerReminderJsonFiles(dirPath);
  const desiredIds = new Set<string>();
  for (const reminder of reminders) {
    if (desiredIds.has(reminder.id)) {
      throw new Error(
        `Duplicate shared reminder_id detected while persisting ${getSharedReminderTargetKey(target)}: ${reminder.id}`,
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
        getSharedReminderFilePath(target, reminder.id),
        serializeReminder(reminder),
      ),
    ),
  );
}

export async function loadSharedReminders(target: SharedReminderTarget): Promise<Reminder[]> {
  const lock = getSharedReminderLock(target);
  const release = await lock.acquire();
  try {
    return cloneReminderList(await readSharedRemindersUnlocked(target));
  } finally {
    release();
    clearSharedReminderLockIfIdle(target, lock);
  }
}

export async function replaceSharedReminders(
  target: SharedReminderTarget,
  reminders: readonly Reminder[],
): Promise<void> {
  const lock = getSharedReminderLock(target);
  const release = await lock.acquire();
  try {
    await writeSharedRemindersUnlocked(target, reminders);
  } finally {
    release();
    clearSharedReminderLockIfIdle(target, lock);
  }
}

export async function mutateSharedReminders<T>(
  target: SharedReminderTarget,
  mutate: (reminders: Reminder[]) => Promise<T> | T,
): Promise<T> {
  const lock = getSharedReminderLock(target);
  const release = await lock.acquire();
  try {
    const reminders = await readSharedRemindersUnlocked(target);
    const result = await mutate(reminders);
    await writeSharedRemindersUnlocked(target, reminders);
    return result;
  } finally {
    release();
    clearSharedReminderLockIfIdle(target, lock);
  }
}
