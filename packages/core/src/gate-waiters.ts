/**
 * In-memory waiters for human-in-the-loop gates.
 *
 * Shared by tool approval, plan, ask-user, and mode-switch. The turn loop awaits
 * `wait()`; a decision route calls `resolve()`. Cancel aborts every waiter for a
 * session so a late decision cannot execute work after the turn has ended.
 */

export type GateKind = 'tool_approval' | 'plan' | 'ask_user' | 'mode_switch';

export class GateCancelledError extends Error {
  readonly gateKind: GateKind;
  readonly gateId: string;

  constructor(kind: GateKind, id: string) {
    super(`Gate cancelled: ${kind}/${id}`);
    this.name = 'GateCancelledError';
    this.gateKind = kind;
    this.gateId = id;
  }
}

export class GateNotFoundError extends Error {
  readonly gateKind: GateKind;
  readonly gateId: string;

  constructor(kind: GateKind, id: string) {
    super(`No open gate: ${kind}/${id}`);
    this.name = 'GateNotFoundError';
    this.gateKind = kind;
    this.gateId = id;
  }
}

export interface OpenGateWaiterOptions {
  sessionId: string;
  kind: GateKind;
  id: string;
}

export interface GateWaiterHandle<T> {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: GateKind;
  wait(signal?: AbortSignal): Promise<T>;
}

interface WaiterEntry {
  sessionId: string;
  kind: GateKind;
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

function gateKey(kind: GateKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Registry of open gate waiters.
 *
 * One entry per gate id. Keys are namespaced by kind so approval, plan, ask, and
 * mode-switch ids never collide even if a host reuses the same uuid shape.
 */
export class GateWaiterRegistry {
  private readonly waiters = new Map<string, WaiterEntry>();

  open<T>(options: OpenGateWaiterOptions): GateWaiterHandle<T> {
    const key = gateKey(options.kind, options.id);
    if (this.waiters.has(key)) {
      throw new Error(`Gate already open: ${key}`);
    }

    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: WaiterEntry = {
      sessionId: options.sessionId,
      kind: options.kind,
      id: options.id,
      resolve,
      reject,
      settled: false,
    };
    this.waiters.set(key, entry);

    return {
      id: options.id,
      sessionId: options.sessionId,
      kind: options.kind,
      wait: (signal?: AbortSignal) => {
        if (signal?.aborted) {
          this.cancelOne(options.kind, options.id);
          return Promise.reject(new GateCancelledError(options.kind, options.id));
        }

        return new Promise<T>((res, rej) => {
          const onAbort = () => {
            this.cancelOne(options.kind, options.id);
          };
          signal?.addEventListener('abort', onAbort, { once: true });

          promise.then(
            (value) => {
              signal?.removeEventListener('abort', onAbort);
              res(value as T);
            },
            (error: unknown) => {
              signal?.removeEventListener('abort', onAbort);
              rej(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
      },
    };
  }

  has(kind: GateKind, id: string): boolean {
    const entry = this.waiters.get(gateKey(kind, id));
    return entry !== undefined && !entry.settled;
  }

  /**
   * Deliver a decision to an open waiter.
   *
   * Returns false when the gate is missing or already settled, so a route can
   * map that to 404 without throwing.
   */
  resolve<T>(kind: GateKind, id: string, value: T): boolean {
    const key = gateKey(kind, id);
    const entry = this.waiters.get(key);
    if (entry === undefined || entry.settled) {
      return false;
    }
    entry.settled = true;
    this.waiters.delete(key);
    entry.resolve(value);
    return true;
  }

  /**
   * Reject one waiter. Used when its abort signal fires.
   *
   * Safe to call more than once: a settled entry is a no-op.
   */
  cancelOne(kind: GateKind, id: string, error?: Error): boolean {
    const key = gateKey(kind, id);
    const entry = this.waiters.get(key);
    if (entry === undefined || entry.settled) {
      return false;
    }
    entry.settled = true;
    this.waiters.delete(key);
    entry.reject(error ?? new GateCancelledError(kind, id));
    return true;
  }

  /**
   * Abort every open waiter for a session.
   *
   * Cancel and follow-up replace must call this so a decision arriving after the
   * turn ends cannot resume an orphaned tool execution.
   */
  cancelSession(sessionId: string, error?: Error): void {
    for (const [key, entry] of this.waiters) {
      if (entry.sessionId !== sessionId || entry.settled) {
        continue;
      }
      entry.settled = true;
      this.waiters.delete(key);
      entry.reject(error ?? new GateCancelledError(entry.kind, entry.id));
    }
  }

  /** Open waiters for one session, useful in tests. */
  listSession(sessionId: string): ReadonlyArray<{ kind: GateKind; id: string }> {
    const out: Array<{ kind: GateKind; id: string }> = [];
    for (const entry of this.waiters.values()) {
      if (entry.sessionId === sessionId && !entry.settled) {
        out.push({ kind: entry.kind, id: entry.id });
      }
    }
    return out;
  }
}
