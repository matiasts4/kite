import type { ContinuationSuggestion } from '../../types';
import { invokeCommand, isTauriEnvironment } from './core';

export async function recommendContinuationTargets(
  currentProvider: string
): Promise<{ currentProvider: string; suggestions: ContinuationSuggestion[] }> {
  try {
    return await invokeCommand('recommend_continuation_targets', { currentProvider });
  } catch (err) {
    console.warn('[IPC] recommendContinuationTargets failed:', err);
    return { currentProvider, suggestions: [] };
  }
}

export async function getHandoffPreview(
  threadId: string,
  fromProvider: string,
  partialText?: string
): Promise<{ handoffPrompt: string }> {
  try {
    return await invokeCommand('get_handoff_preview', { threadId, fromProvider, partialText });
  } catch (err) {
    console.warn('[IPC] getHandoffPreview failed:', err);
    return { handoffPrompt: '' };
  }
}

export async function continueTurnWithHandoff(
  threadId: string,
  targetProvider: string,
  targetAccountId?: string,
  customHandoffPrompt?: string
): Promise<any> {
  return await invokeCommand('continue_turn_with_handoff', {
    threadId,
    targetProvider,
    targetAccountId,
    customHandoffPrompt,
  });
}

export interface ProxyOperatorHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  timeoutSecs?: number;
}

export interface ProxyOperatorHttpResponse {
  success: boolean;
  status: number;
  body?: string;
  error?: string;
  latencyMs: number;
}

export async function proxyOperatorHttp(
  req: ProxyOperatorHttpRequest
): Promise<ProxyOperatorHttpResponse> {
  return invokeCommand<ProxyOperatorHttpResponse>('proxy_operator_http', req as unknown as Record<string, unknown>);
}

export async function operatorDuckAudio(ratio: number = 0.20): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  try {
    return await invokeCommand<boolean>('operator_duck_audio', { ratio });
  } catch {
    return false;
  }
}

export async function operatorRestoreAudio(): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  try {
    return await invokeCommand<boolean>('operator_restore_audio', {});
  } catch {
    return false;
  }
}

export async function operatorPlayCueSound(start: boolean): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  try {
    return await invokeCommand<boolean>('operator_play_cue_sound', { start });
  } catch {
    return false;
  }
}

export async function operatorOnRecordingStateChange(recording: boolean): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  try {
    return await invokeCommand<boolean>('operator_on_recording_state_change', { recording });
  } catch {
    return false;
  }
}
