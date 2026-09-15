/**
 * Turn-loop specification checklist.
 *
 * These tests are intentionally skipped. Each one names a behavior the runtime is
 * specified to have but has not implemented yet, so the suite doubles as the work
 * queue for the turn loop.
 *
 * Rules:
 * - Do not delete a test here to make a run green. Implement it and unskip it.
 * - Do not unskip a test without an assertion; a passing empty test is worse than
 *   a skipped one, because it reports coverage that does not exist.
 * - Keep one behavior per test. When one fails during implementation it should
 *   name the broken behavior on its own.
 *
 * `SPEC.md` is the normative description of everything below.
 */

import { createHarness } from '@evu/harness-core';
import { describe, expect, it } from 'vitest';

describe('turn loop: streaming', () => {
  it.skip('emits status, then deltas, then a terminal done event', () => {});

  it.skip('emits exactly one terminal event per turn', () => {});

  it.skip('emits nothing after a terminal event', () => {});

  it.skip('accumulates delta text into the persisted assistant message', () => {});

  it.skip('emits reasoning_delta only when the provider produces reasoning', () => {});

  it.skip('reports token usage and accumulates session totals', () => {});

  it.skip('surfaces a provider failure as an error event rather than throwing', () => {});

  it.skip('persists a partial assistant message when the provider dies mid-stream', () => {});
});

describe('turn loop: tool rounds', () => {
  it.skip('executes a requested tool and feeds the result back to the model', () => {});

  it.skip('runs several tool rounds until the model stops requesting tools', () => {});

  it.skip('stops at the configured round cap', () => {});

  it.skip('nudges the model to synthesize an answer when the cap is reached', () => {});

  it.skip('reports a tool error to the model without ending the turn', () => {});

  it.skip('rejects a tool that is not in the turn pin allowlist', () => {});

  it.skip('rejects a tool outside the pinned mode even when a grant exists', () => {});

  it.skip('tolerates malformed tool arguments without crashing the turn', () => {});
});

describe('turn loop: cancellation', () => {
  it.skip('stops the provider stream when cancelled', () => {});

  it.skip('persists whatever text was produced before the cancel', () => {});

  it.skip('marks the persisted transcript row as cancelled', () => {});

  it.skip('emits a cancelled event rather than an error', () => {});

  it.skip('reports reason operator for a user-initiated cancel', () => {});

  it.skip('emits a quiet cancelled event when nothing was produced', () => {});

  it.skip('does not leave an orphaned approval waiter that later executes a tool', () => {});

  it.skip('aborts an in-flight tool handler via its signal', () => {});
});

describe('turn loop: follow-up queue', () => {
  it.skip('cancels a live turn when a new user message arrives', () => {});

  it.skip('reports reason follow_up for that cancel', () => {});

  it.skip('persists the interrupted turn before starting the next one', () => {});

  it.skip('drains several queued messages as a single next turn', () => {});

  it.skip('pins the queued turn to the mode sent with it', () => {});

  it.skip('preserves queued message order', () => {});
});

describe('turn loop: tool approval gate', () => {
  it.skip('suspends the turn instead of executing a gated tool', () => {});

  it.skip('emits tool_approval_required carrying the argument digest', () => {});

  it.skip('resumes and executes the tool after allow_once', () => {});

  it.skip('resumes under the original pinned mode after an approval wait', () => {});

  it.skip('reports a refusal to the model after deny', () => {});

  it.skip('does not re-prompt for a tool already granted for the session', () => {});

  it.skip('re-prompts when the same tool is called with different arguments', () => {});

  it.skip('does not execute a gated tool before the decision arrives', () => {});
});

describe('turn loop: plan gate', () => {
  it.skip('suspends the turn when the model proposes a plan', () => {});

  it.skip('switches the session to agent mode on plan approval', () => {});

  it.skip('mints one-shot receipts for the approved plan steps', () => {});

  it.skip('discards the plan and leaves the mode unchanged on discard', () => {});

  it.skip('does not let plan approval widen what the planning turn could do', () => {});
});

describe('turn loop: ask-user gate', () => {
  it.skip('suspends the turn and emits ask_user_required', () => {});

  it.skip('resumes with the answer available to the model', () => {});

  it.skip('supports free-form answers as well as choices', () => {});

  it.skip('records the exchange as transcript rows, not as a tool result', () => {});

  it.skip('rejects an answer for an ask that is no longer pending', () => {});
});

describe('turn loop: mode switch gate', () => {
  it.skip('suspends the turn when the model requests a mode switch', () => {});

  it.skip('writes the session default mode on approval', () => {});

  it.skip('leaves the running turn on its original pinned mode after approval', () => {});

  it.skip('reports the denial to the model on deny', () => {});
});

describe('turn loop: prompt and skills', () => {
  it.skip('builds the system prompt once per turn from the pin', () => {});

  it.skip('merges a loaded skill into the leading system message', () => {});

  it.skip('never inserts a second system message mid-thread', () => {});

  it.skip('applies a context resolver result as an appended context block', () => {});

  it.skip('applies a command resolver result before the turn starts', () => {});
});

describe('turn loop: session persistence', () => {
  it.skip('keeps the model thread and the UI transcript in step', () => {});

  it.skip('titles a session from its first user message', () => {});

  it.skip('serializes concurrent turns on one session', () => {});

  it.skip('does not persist on every delta', () => {});
});

/**
 * A guard on the checklist itself, so it cannot rot into decoration.
 *
 * If the harness ever grows a `runTurn` entry point, this fails and forces the
 * skipped tests above to be revisited rather than quietly left behind.
 */
describe('checklist guard', () => {
  it('has no turn-loop entry point yet, so the skipped tests above are still the plan', () => {
    const harness = createHarness();

    expect('runTurn' in harness).toBe(false);
    expect(typeof harness.pinTurn).toBe('function');
  });
});
