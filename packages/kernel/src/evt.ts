/**
 * Event processing constructs equivalent to Edh's:
 * - PubChan: write-only broadcast channel
 * - SubChan: read-only subscriber channel
 * - EventSink: event source with sequence and most-recent value, streaming support
 *
 * Notes:
 * - PubChan behaves like a broadcast channel: if there is no SubChan reading, writes are effectively dropped
 * - SubChan buffers unboundedly relative to its own consumption speed
 * - EndOfStream sentinel signals termination of streams
 */

export const EndOfStream = Symbol('EndOfStream');
export type EOS = typeof EndOfStream;

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}> {
  let resolveFn: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  if (!resolveFn) {
    throw new Error('Deferred initialization failed.');
  }
  return { promise, resolve: resolveFn };
}

type NodeValue<T> = readonly [value: T | EOS, next: Promise<NodeValue<T>>];

export class PubChan<T> {
  private nxt = deferred<NodeValue<T>>();

  write(ev: T | EOS): void {
    const next = deferred<NodeValue<T>>();
    this.nxt.resolve([ev, next.promise]);
    this.nxt = next;
  }

  get nextPromise(): Promise<NodeValue<T>> {
    return this.nxt.promise;
  }
}

export class SubChan<T> {
  private nxtP: Promise<NodeValue<T>>;
  public readonly cancelled: Promise<void>;
  public readonly cancel: () => void;

  constructor(pub: PubChan<T>) {
    this.nxtP = pub.nextPromise;
    const cancelDefer = deferred<void>();
    this.cancelled = cancelDefer.promise;
    this.cancel = () => cancelDefer.resolve();
  }

  async read(): Promise<T | EOS> {
    const raceResult = await Promise.race([this.cancelled, this.nxtP]);
    if (raceResult === undefined) {
      return EndOfStream;
    }
    const [ev, nextP] = raceResult;
    this.nxtP = nextP;
    return ev;
  }

  stream(): AsyncGenerator<T, void, void> {
    let nxtP = this.nxtP;
    return (async function* (self: SubChan<T>) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await Promise.race([self.cancelled, nxtP]);
        if (result === undefined) {
          return;
        }
        const [ev, nextPResolved] = result;
        nxtP = self.nxtP = nextPResolved;
        if (ev === EndOfStream) {
          return;
        }
        yield ev;
      }
    })(this);
  }
}

export class EventSink<T> {
  private seqn = 0;
  private mrv: T | EOS | null = null;
  private readonly chan = new PubChan<T>();

  get eos(): boolean {
    return this.mrv === EndOfStream;
  }

  publish(ev: T | EOS): void {
    if (ev === EndOfStream && this.mrv === EndOfStream) {
      return;
    }

    if (this.seqn >= 9_223_372_036_854_775_807) {
      this.seqn = 1;
    } else {
      this.seqn += 1;
    }
    this.mrv = ev;
    this.chan.write(ev);
  }

  async one_more(): Promise<T | EOS> {
    if (this.seqn > 0 && this.mrv === EndOfStream) {
      return EndOfStream;
    }
    const [ev] = await this.chan.nextPromise;
    return ev;
  }

  stream(): AsyncGenerator<T, void, void> {
    const yield1st = this.mrv;
    const shouldYield1st = this.seqn > 0;
    let nxtP = this.chan.nextPromise;
    return (async function* () {
      if (shouldYield1st) {
        if (yield1st === EndOfStream) {
          return;
        }
        if (yield1st !== null) {
          yield yield1st;
        }
      }

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const [ev, nextP] = await Promise.resolve(nxtP);
        if (ev === EndOfStream) {
          return;
        }
        yield ev;
        nxtP = nextP;
      }
    })();
  }
}

export function createPubChan<T>(): PubChan<T> {
  return new PubChan<T>();
}

export function createSubChan<T>(pub: PubChan<T>): SubChan<T> {
  return new SubChan<T>(pub);
}

export function createEventSink<T>(): EventSink<T> {
  return new EventSink<T>();
}
