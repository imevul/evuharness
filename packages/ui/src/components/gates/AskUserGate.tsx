import type { AskUserAnswer, PendingAskUser } from '@evu/harness-protocol';
import { useCallback, useState } from 'react';

export interface AskUserGateProps {
  ask: PendingAskUser;
  onAnswer: (answers: AskUserAnswer[]) => void;
}

/**
 * The ask-user gate: structured questions from the model.
 *
 * A first-class gate rather than a tool that happens to return a question, so every
 * surface renders it natively instead of pattern-matching tool output. Both choice
 * and free-form answers travel on one `AskUserAnswer`, since a question can offer
 * choices and still accept "something else".
 */
export function AskUserGate({ ask, onAnswer }: AskUserGateProps) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [freeForm, setFreeForm] = useState<Record<string, string>>({});

  const toggle = useCallback((questionId: string, choiceId: string, allowMultiple: boolean) => {
    setSelected((current) => {
      const existing = current[questionId] ?? [];
      if (!allowMultiple) {
        return { ...current, [questionId]: existing.includes(choiceId) ? [] : [choiceId] };
      }
      return {
        ...current,
        [questionId]: existing.includes(choiceId)
          ? existing.filter((id) => id !== choiceId)
          : [...existing, choiceId],
      };
    });
  }, []);

  const submit = useCallback(() => {
    onAnswer(
      ask.questions.map((question) => {
        const text = freeForm[question.id];
        return {
          questionId: question.id,
          selected: selected[question.id] ?? [],
          // Omitted when blank so an untouched field does not read as an empty answer.
          ...(text === undefined || text === '' ? {} : { text }),
        };
      }),
    );
  }, [ask.questions, selected, freeForm, onAnswer]);

  // Every question needs some answer; a partial submission would leave the model
  // guessing which blanks were deliberate.
  const complete = ask.questions.every((question) => {
    const picks = selected[question.id] ?? [];
    const text = freeForm[question.id] ?? '';
    return picks.length > 0 || text.trim() !== '';
  });

  return (
    <div data-harness="gate" data-gate="ask-user">
      {ask.questions.map((question) => (
        <fieldset key={question.id} data-harness="ask-question">
          <legend>{question.prompt}</legend>

          {question.choices.map((choice) => (
            <label key={choice.id} data-harness="ask-choice">
              <input
                type={question.allowMultiple ? 'checkbox' : 'radio'}
                name={question.id}
                checked={(selected[question.id] ?? []).includes(choice.id)}
                onChange={() => toggle(question.id, choice.id, question.allowMultiple)}
              />
              {choice.label}
            </label>
          ))}

          {question.allowFreeForm && (
            <input
              type="text"
              data-harness="ask-freeform"
              placeholder="Something else…"
              value={freeForm[question.id] ?? ''}
              onChange={(event) =>
                setFreeForm((current) => ({ ...current, [question.id]: event.target.value }))
              }
            />
          )}
        </fieldset>
      ))}

      <div data-harness="gate-actions">
        <button type="button" onClick={submit} disabled={!complete}>
          Submit
        </button>
      </div>
    </div>
  );
}
