/**
 * Async FIFO mutex (fair queue).
 *
 * Used for per-dialog and per-dialog-tree critical sections, keyed by dialog ID.
 */
export class AsyncFifoMutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    return () => this.release();
  }

  isLocked(): boolean {
    return this.locked;
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}
