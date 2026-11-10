import { usageDetails } from './usageDetails';

export function ThreadUsageCard({
  reported,
  inputTokens,
  outputTokens,
  contextWindowTokens,
  transcriptText,
}: {
  reported?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  contextWindowTokens?: number;
  transcriptText?: string;
}) {
  const hasRecord = reported !== undefined
    || inputTokens !== undefined
    || outputTokens !== undefined
    || contextWindowTokens !== undefined;
  const details = usageDetails(
    hasRecord ? { reported, inputTokens, outputTokens, contextWindowTokens } : null,
    transcriptText,
  );
  if (!details) return null;
  return (
    <section className="thread-usage-card rounded-card" aria-label="Thread usage">
      <span>Input {details.inputTokens}</span>
      <span>Output {details.outputTokens}</span>
      <span>Context {details.contextWindowTokens}</span>
    </section>
  );
}
