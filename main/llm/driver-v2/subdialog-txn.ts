import type { DialogID } from '../../dialog';
import { DialogPersistence } from '../../persistence';
import { AsyncFifoMutex } from '../../shared/async-fifo-mutex';

export type TakenSubdialogResponse = Awaited<
  ReturnType<typeof DialogPersistence.takeSubdialogResponses>
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

export async function takeSubdialogResponses(
  dialogId: DialogID,
): Promise<TakenSubdialogResponse[]> {
  return await withSuspensionStateLock(dialogId, async () => {
    return await DialogPersistence.takeSubdialogResponses(dialogId);
  });
}

export async function commitTakenSubdialogResponses(dialogId: DialogID): Promise<void> {
  await withSuspensionStateLock(dialogId, async () => {
    await DialogPersistence.commitTakenSubdialogResponses(dialogId);
  });
}

export async function rollbackTakenSubdialogResponses(dialogId: DialogID): Promise<void> {
  await withSuspensionStateLock(dialogId, async () => {
    await DialogPersistence.rollbackTakenSubdialogResponses(dialogId);
  });
}

export async function withSubdialogTxnLock<T>(
  dialogId: DialogID,
  fn: () => Promise<T>,
): Promise<T> {
  return await withSuspensionStateLock(dialogId, fn);
}
