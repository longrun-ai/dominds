import type { DialogID } from '../../dialog';
import { DialogPersistence } from '../../persistence';
import { AsyncFifoMutex } from '../../runtime/async-fifo-mutex';

export type TakenSideDialogResponse = Awaited<
  ReturnType<typeof DialogPersistence.takeSideDialogResponses>
>[number];

const suspensionStateMutexes = new Map<string, AsyncFifoMutex>();

async function withSuspensionStateLock<T>(dialogId: DialogID, fn: () => Promise<T>): Promise<T> {
  const key = dialogId.key();
  let mutex = suspensionStateMutexes.get(key);
  if (!mutex) {
    mutex = new AsyncFifoMutex();
    suspensionStateMutexes.set(key, mutex);
  }
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function takeSideDialogResponses(
  dialogId: DialogID,
): Promise<TakenSideDialogResponse[]> {
  return await withSuspensionStateLock(dialogId, async () => {
    return await DialogPersistence.takeSideDialogResponses(dialogId);
  });
}

export async function commitTakenSideDialogResponses(dialogId: DialogID): Promise<void> {
  await withSuspensionStateLock(dialogId, async () => {
    await DialogPersistence.commitTakenSideDialogResponses(dialogId);
  });
}

export async function rollbackTakenSideDialogResponses(dialogId: DialogID): Promise<void> {
  await withSuspensionStateLock(dialogId, async () => {
    await DialogPersistence.rollbackTakenSideDialogResponses(dialogId);
  });
}

export async function withSideDialogTxnLock<T>(
  dialogId: DialogID,
  fn: () => Promise<T>,
): Promise<T> {
  return await withSuspensionStateLock(dialogId, fn);
}

export async function withSideDialogTxnLocks<T>(
  dialogIds: readonly DialogID[],
  fn: () => Promise<T>,
): Promise<T> {
  const ordered = [
    ...new Map(dialogIds.map((dialogId) => [dialogId.key(), dialogId])).values(),
  ].sort((left, right) => left.key().localeCompare(right.key()));
  let index = 0;
  const run = async (): Promise<T> => {
    if (index >= ordered.length) {
      return await fn();
    }
    const dialogId = ordered[index];
    index += 1;
    return await withSuspensionStateLock(dialogId, run);
  };
  return await run();
}
