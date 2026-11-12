import { useEffect, useState } from 'react';

export interface PendingQuestion {
  id: string;
  header: string;
  options: string[];
  allowCustomAnswer?: boolean;
  allowAttachments?: boolean;
  multiSelect?: boolean;
}

export function ComposerPendingUserInputPanel({
  questions,
  onSubmit,
}: {
  questions: PendingQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState('');
  const question = questions[index];
  const choose = (option: string) => {
    if (!question) return;
    const next = { ...answers, [question.id]: option };
    setAnswers(next);
    if (question.multiSelect) return;
    if (index + 1 < questions.length) {
      window.setTimeout(() => setIndex(index + 1), 200);
      return;
    }
    onSubmit(next);
  };
  useEffect(() => {
    if (!question || question.multiSelect) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return;
      const option = question.options[digit - 1];
      if (!option) return;
      event.preventDefault();
      choose(option);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [question, index, answers]);
  if (!question) return null;
  return (
    <section className="rounded-card border border-border p-3" aria-label="Agent question">
      <p>{index + 1} of {questions.length}</p>
      <h3>{question.header}</h3>
      <ul>
        {question.options.map((option, optionIndex) => (
          <li key={option}>
            <button type="button" onClick={() => choose(option)}>
              {optionIndex + 1}. {option}
            </button>
          </li>
        ))}
      </ul>
      {question.allowCustomAnswer ? (
        <input aria-label="Custom answer" value={custom} onChange={(event) => setCustom(event.target.value)} />
      ) : null}
      {question.allowAttachments ? <button type="button">Attach files</button> : null}
      {question.multiSelect ? (
        <button type="button" onClick={() => onSubmit(answers)}>Continue</button>
      ) : null}
    </section>
  );
}
