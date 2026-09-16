import { GateCancelledError, GateWaiterRegistry } from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

describe('GateWaiterRegistry', () => {
  it('resolves a waiter with the decision value', async () => {
    const gates = new GateWaiterRegistry();
    const handle = gates.open<string>({
      sessionId: 's1',
      kind: 'tool_approval',
      id: 'a1',
    });

    const waiting = handle.wait();
    expect(gates.resolve('tool_approval', 'a1', 'allow_once')).toBe(true);
    await expect(waiting).resolves.toBe('allow_once');
    expect(gates.has('tool_approval', 'a1')).toBe(false);
  });

  it('rejects waiters when the session is cancelled', async () => {
    const gates = new GateWaiterRegistry();
    const handle = gates.open<string>({
      sessionId: 's1',
      kind: 'plan',
      id: 'p1',
    });
    const waiting = handle.wait();
    gates.cancelSession('s1');
    await expect(waiting).rejects.toBeInstanceOf(GateCancelledError);
    expect(gates.resolve('plan', 'p1', 'x')).toBe(false);
  });

  it('namespaces ids by gate kind', async () => {
    const gates = new GateWaiterRegistry();
    const approval = gates.open<string>({ sessionId: 's1', kind: 'tool_approval', id: 'same' });
    const ask = gates.open<string>({ sessionId: 's1', kind: 'ask_user', id: 'same' });

    expect(gates.resolve('tool_approval', 'same', 'deny')).toBe(true);
    expect(gates.resolve('ask_user', 'same', 'answered')).toBe(true);
    await expect(approval.wait()).resolves.toBe('deny');
    await expect(ask.wait()).resolves.toBe('answered');
  });
});
