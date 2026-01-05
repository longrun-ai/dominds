/**
 * Module: llm/dialog-mutex
 *
 * Mutex-based dialog loading control for ensuring exclusive dialog access.
 * Uses async-mutex to provide tryLock/release pattern for dialog driving.
 */
import { Mutex } from 'async-mutex';

export class DialogMutex {
  private mutex = new Mutex();
  private dialogId: string;

  constructor(dialogId: string) {
    this.dialogId = dialogId;
  }

  /**
   * Try to acquire the lock for this dialog.
   * @returns Promise that resolves to release function if lock acquired, undefined otherwise
   */
  async tryLock(): Promise<(() => void) | undefined> {
    const release = await this.mutex.acquire();
    return release;
  }

  /**
   * Run a function with the mutex locked.
   * @param fn The function to run
   * @returns Promise that resolves to the function's return value
   */
  async runWithLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(fn);
  }

  /**
   * Get the dialog ID this mutex is for
   */
  get dialogIdValue(): string {
    return this.dialogId;
  }
}

/**
 * Manages dialog loading with mutex-based exclusive access control.
 * Ensures that only one driver can process a dialog at a time.
 */
export class DialogLoadingMutex {
  private mutexes: Map<string, DialogMutex> = new Map();

  /**
   * Get or create a mutex for the given dialog ID
   */
  getMutex(dialogId: string): DialogMutex {
    let mutex = this.mutexes.get(dialogId);
    if (!mutex) {
      mutex = new DialogMutex(dialogId);
      this.mutexes.set(dialogId, mutex);
    }
    return mutex;
  }

  /**
   * Try to lock a dialog for exclusive access
   * @param dialogId The dialog ID to lock
   * @returns Promise resolving to release function if lock acquired, undefined otherwise
   */
  async tryLock(dialogId: string): Promise<(() => void) | undefined> {
    const mutex = this.getMutex(dialogId);
    return mutex.tryLock();
  }

  /**
   * Run a function with the dialog locked exclusively
   * @param dialogId The dialog ID to lock
   * @param fn The async function to run
   * @returns Promise resolving to the function's return value
   */
  async runWithLock<T>(dialogId: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.getMutex(dialogId);
    return mutex.runWithLock(fn);
  }
}

/**
 * Singleton instance for dialog loading mutex
 */
export const loadedDialogs = new DialogLoadingMutex();
