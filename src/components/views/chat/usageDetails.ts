export interface UsageDetails {
  inputTokens: number;
  outputTokens: number;
  contextWindowTokens: number;
}

export function usageDetails(
  record?: {
    reported?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    contextWindowTokens?: number;
  } | null,
  transcriptText?: string,
): UsageDetails | null {
  void transcriptText;
  if (!record || record.reported !== true) return null;
  if (
    typeof record.inputTokens !== 'number'
    || typeof record.outputTokens !== 'number'
    || typeof record.contextWindowTokens !== 'number'
  ) {
    return null;
  }
  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    contextWindowTokens: record.contextWindowTokens,
  };
}
