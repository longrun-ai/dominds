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

/**
 * A small "deferred" helper to build a promise that can be resolved externally.
 */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type NodeValue<T> = [value: T | EOS, next: Promise<NodeValue<T>>];

/**
 * PubChan: publisher's write-only channel.
 * Internally maintains a linked list of deferred promises to form a stream.
 */
export class PubChan<T> {
  // The head of the chain: a deferred whose promise yields [ev, nextPromise]
  private nxt = deferred<NodeValue<T>>();
  private writes = 0;

  /**
   * Write an event into the channel.
   * Subsequent readers will observe it in order.
   */
  write(ev: T | EOS): void {
    const next = deferred<NodeValue<T>>();
    // Resolve current node with [event, nextPromise], then advance head
    this.nxt.resolve([ev, next.promise]);
    this.nxt = next;
    this.writes += 1;
  }

  /**
   * Expose current next promise for SubChan to adopt.
   * Consumers should typically not use this directly.
   */
  get nextPromise(): Promise<NodeValue<T>> {
    return this.nxt.promise;
  }
}

/**
 * SubChan: subscriber's read-only channel.
 * Holds its own pointer into the shared stream chain, thus buffering
 * independently of other subscribers.
 */
export class SubChan<T> {
  private nxtP: Promise<NodeValue<T>>;
  public readonly cancelled: Promise<void>;
  public cancel: () => void;
  private reads = 0;

  constructor(pub: PubChan<T>) {
    this.nxtP = pub.nextPromise;
    const cancelDefer = deferred<void>();
    this.cancelled = cancelDefer.promise;
    this.cancel = () => cancelDefer.resolve();
  }

  /**
   * Read the next available value (could be EndOfStream).
   * Caller may check ev === EndOfStream to detect eos.
   */
  async read(): Promise<T | EOS> {
    // If cancelled, return EndOfStream immediately
    const raceResult = await Promise.race([this.cancelled, this.nxtP]);
    if (raceResult === undefined) {
      return EndOfStream;
    }
    const [ev, nextP] = raceResult;
    this.nxtP = nextP;
    this.reads += 1;
    return ev;
  }

  /**
   * Async iterator over values until EndOfStream or cancellation.
   */
  stream(): AsyncGenerator<T, void, void> {
    let nxtP = this.nxtP;
    return (async function* (self: SubChan<T>) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await Promise.race([self.cancelled, nxtP]);
        // If cancelled (undefined), return immediately
        if (result === undefined) {
          return;
        }
        const [ev, nextP] = result;
        nxtP = self.nxtP = nextP;
        if (ev === EndOfStream) return;
        yield ev as T;
      }
    })(this);
  }
}

/**
 * EventSink: holds sequence, most recent value, and a PubChan.
 * Provides stream(), one_more(), and run_producer() helpers.
 */
export class EventSink<T> {
  private seqn = 0;
  private mrv: T | EOS | null = null;
  private readonly chan = new PubChan<T>();

  get eos(): boolean {
    return this.mrv === EndOfStream;
  }

  /**
   * Publish an event. Increments sequence (wraps int64 max to 1).
   * Ignores repeated EndOfStream publications after the first one.
   */
  publish(ev: T | EOS): void {
    if (ev === EndOfStream && this.mrv === EndOfStream) {
      // Already published EndOfStream, ignore repeated attempts
      return;
    }

    if (this.seqn >= 9223372036854775807) {
      this.seqn = 1;
    } else {
      this.seqn += 1;
    }
    this.mrv = ev;
    this.chan.write(ev);
  }

  /**
   * Await exactly one more item from the stream unless already at eos.
   * If already eos after at least one event, returns EndOfStream immediately.
   */
  async one_more(): Promise<T | EOS> {
    if (this.seqn > 0 && this.mrv === EndOfStream) {
      return EndOfStream;
    }
    // Peek the next from channel's head
    const [ev] = await this.chan.nextPromise;
    return ev;
  }

  /**
   * Async iterator: yields the most recent value first (if any and not eos),
   * then continues with subsequent events until EndOfStream.
   */
  stream(): AsyncGenerator<T, void, void> {
    // Capture stream state at call time: capture the current most recent value and
    // promise chain position immediately when this method is invoked. This prevents
    // race conditions where events could be missed if we captured state when the
    // returned generator starts iterating (which might be much later).
    const yield1st = this.mrv;
    const shouldYield1st = this.seqn > 0;
    let nxtP = this.chan.nextPromise;
    return (async function* () {
      if (shouldYield1st) {
        if (yield1st === EndOfStream) return;
        // yield the most recent first
        yield yield1st as T;
      }
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const [ev, nextP] = await Promise.resolve(nxtP);
        if (ev === EndOfStream) return;
        yield ev as T;
        nxtP = nextP;
      }
    })();
  }
}

/**
 * Helpers to create channels/sinks
 */
export function createPubChan<T>(): PubChan<T> {
  return new PubChan<T>();
}

export function createSubChan<T>(pub: PubChan<T>): SubChan<T> {
  return new SubChan<T>(pub);
}

export function createEventSink<T>(): EventSink<T> {
  return new EventSink<T>();
}
