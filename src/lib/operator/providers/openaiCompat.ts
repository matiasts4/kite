// Kite Code — OpenAI Compatible Planner Provider
// Handles OpenCode Multi-Model Gateway, Vercel AI, and custom OpenAI-compatible endpoints
// with streaming SSE deltas, native tool-call parsing, cancellation, timeouts, and safe non-streaming fallback.

import { operatorHttpFetch } from '../operatorConfig';
import { OPERATOR_NATIVE_TOOLS } from '../contract';
import type {
  PlannerProvider,
  ProviderMessage,
  PlannerProviderResult,
  PlannerProviderOptions,
  PlannerToolCall,
  PlannerTokenCounts,
} from './types';

export interface OpenAiCompatOptions {
  id?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Native proxy credential source. When set, the Tauri proxy can inject the
   * provider token server-side if apiKey is empty (OpenCode Go reads the key
   * from the local OpenCode CLI store).
   */
  credentialProvider?: 'opencode';
  /** Stable OpenCode Go session id, sent as x-opencode-session. */
  sessionId?: string;
}

export class OpenAiCompatPlannerProvider implements PlannerProvider {
  public readonly id: string;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private credentialProvider?: 'opencode';
  private sessionId?: string;

  constructor(options: OpenAiCompatOptions) {
    this.id = options.id || 'opencode';
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature ?? 0.0;
    this.maxTokens = options.maxTokens ?? 500;
    this.credentialProvider = options.credentialProvider;
    this.sessionId = options.sessionId;
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
    };
    const key = this.apiKey.trim();
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    const sessionId = this.sessionId?.trim();
    if (sessionId) {
      headers['x-opencode-session'] = sessionId;
    }
    return headers;
  }

  public async plan(
    messages: ProviderMessage[],
    options?: PlannerProviderOptions
  ): Promise<PlannerProviderResult> {
    const startTime = Date.now();
    const normalizedBase = this.baseUrl.replace(/\/+$/, '');
    const endpoint = normalizedBase.endsWith('/chat/completions')
      ? normalizedBase
      : `${normalizedBase}/chat/completions`;

    const controller = new AbortController();
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    if (options?.timeoutSecs && options.timeoutSecs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Provider request timed out after ${options.timeoutSecs}s`));
      }, options.timeoutSecs * 1000);
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      options.signal.addEventListener('abort', () => {
        controller.abort(options.signal?.reason || new Error('The operation was aborted'));
      });
    }

    const wantStream = options?.stream !== false;
    const tools = options?.tools || OPERATOR_NATIVE_TOOLS;

    try {
      if (wantStream) {
        try {
          return await this.executeStreaming(endpoint, messages, tools, startTime, controller.signal, options);
        } catch (streamErr: any) {
          // If error was cancellation or timeout or malformed tool args, rethrow directly
          if (
            timedOut ||
            streamErr?.name === 'AbortError' ||
            streamErr?.errorCategory === 'malformed_tool_args' ||
            /timed out/i.test(streamErr?.message || '')
          ) {
            throw streamErr;
          }
          // If streaming failed early before receiving deltas and stream wasn't strictly enforced, fallback to non-streaming
          if (options?.stream === true) {
            throw streamErr;
          }
          console.warn('[OpenAiCompat] Streaming failed; falling back to non-streaming JSON:', streamErr);
          return await this.executeNonStreaming(endpoint, messages, tools, startTime, controller.signal, options);
        }
      } else {
        return await this.executeNonStreaming(endpoint, messages, tools, startTime, controller.signal, options);
      }
    } catch (err: any) {
      if (timedOut || /timed out/i.test(err?.message || '')) {
        const timeoutErr = new Error(`Provider request timed out after ${options?.timeoutSecs}s`);
        (timeoutErr as any).errorCategory = 'timeout';
        throw timeoutErr;
      }
      throw err;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  private async executeStreaming(
    endpoint: string,
    messages: ProviderMessage[],
    tools: unknown[],
    startTime: number,
    signal: AbortSignal,
    options?: PlannerProviderOptions
  ): Promise<PlannerProviderResult> {
    const response = await (typeof fetch === 'function' && !((window as any)?.__TAURI_INTERNALS__)
      ? fetch(endpoint, {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify({
            model: this.model,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            tools,
            messages,
          }),
          signal,
        })
      : operatorHttpFetch(endpoint, {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify({
            model: this.model,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            stream: true,
            stream_options: { include_usage: true },
            tools,
            messages,
          }),
          signal,
        }, { credentialProvider: this.credentialProvider }));

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Error HTTP ${response.status} desde ${endpoint}${errText ? `: ${errText}` : ''}`);
    }

    let firstTokenMs: number | undefined;
    let accumulatedContent = '';
    let tokenCounts: PlannerTokenCounts | undefined;
    const accumulatedTools: Record<number, { id: string; name: string; arguments: string }> = {};

    const processSseLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') return;

      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.usage) {
          tokenCounts = {
            prompt: parsed.usage.prompt_tokens,
            completion: parsed.usage.completion_tokens,
            cache: parsed.usage.prompt_tokens_details?.cached_tokens,
          };
        }

        const choice = parsed.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;
        if (!delta) return;

        // Content delta
        if (typeof delta.content === 'string' && delta.content) {
          if (firstTokenMs === undefined) {
            firstTokenMs = Date.now() - startTime;
            options?.onFirstToken?.(Date.now());
          }
          accumulatedContent += delta.content;
          options?.onDelta?.(delta.content);
        }

        // Tool calls delta
        if (Array.isArray(delta.tool_calls)) {
          if (firstTokenMs === undefined) {
            firstTokenMs = Date.now() - startTime;
            options?.onFirstToken?.(Date.now());
          }
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!accumulatedTools[idx]) {
              accumulatedTools[idx] = { id: tc.id || '', name: '', arguments: '' };
            }
            if (tc.id) accumulatedTools[idx].id = tc.id;
            if (tc.function?.name) accumulatedTools[idx].name += tc.function.name;
            if (tc.function?.arguments) accumulatedTools[idx].arguments += tc.function.arguments;
          }
        }
      } catch {
        // ignore unparseable partial line
      }
    };

    if (response.body && typeof (response.body as any).getReader === 'function') {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            processSseLine(line);
          }
        }
        if (buffer.trim()) {
          processSseLine(buffer);
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
      // Fallback: body was provided as full text (e.g. mock or proxy)
      const fullText = await response.text();
      const lines = fullText.split(/\r?\n/);
      for (const line of lines) {
        processSseLine(line);
      }
    }

    // Assemble tool calls
    const parsedToolCalls: PlannerToolCall[] = [];
    for (const item of Object.values(accumulatedTools)) {
      let parsedArgs: Record<string, unknown> = {};
      if (item.arguments && item.arguments.trim()) {
        try {
          parsedArgs = JSON.parse(item.arguments);
        } catch (err: any) {
          const malformedErr = new Error(`Malformed tool arguments for ${item.name}: ${err?.message || String(err)}`);
          (malformedErr as any).errorCategory = 'malformed_tool_args';
          throw malformedErr;
        }
      }
      const tc: PlannerToolCall = {
        id: item.id || undefined,
        name: item.name,
        arguments: parsedArgs,
      };
      parsedToolCalls.push(tc);
      options?.onToolCall?.(tc);
    }

    const latencyMs = Date.now() - startTime;
    return {
      rawText: accumulatedContent,
      latencyMs,
      model: this.model,
      firstTokenMs,
      toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
      tokenCounts,
    };
  }

  private async executeNonStreaming(
    endpoint: string,
    messages: ProviderMessage[],
    tools: unknown[],
    startTime: number,
    signal: AbortSignal,
    options?: PlannerProviderOptions
  ): Promise<PlannerProviderResult> {
    const response = await (typeof fetch === 'function' && !((window as any)?.__TAURI_INTERNALS__)
      ? fetch(endpoint, {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify({
            model: this.model,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            tools,
            messages,
          }),
          signal,
        })
      : operatorHttpFetch(endpoint, {
          method: 'POST',
          headers: this.requestHeaders(),
          body: JSON.stringify({
            model: this.model,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            tools,
            messages,
          }),
          signal,
        }, { credentialProvider: this.credentialProvider }));

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Error HTTP ${response.status} desde ${endpoint}${errText ? `: ${errText}` : ''}`);
    }

    const data = await response.json();
    const rawText: string = data?.choices?.[0]?.message?.content ?? '';
    const parsedToolCalls: PlannerToolCall[] = [];

    const rawToolCalls = data?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls) {
        const name = tc.function?.name || tc.name || '';
        const rawArgs = tc.function?.arguments ?? tc.arguments ?? '{}';
        let parsedArgs: Record<string, unknown> = {};
        if (typeof rawArgs === 'string') {
          try {
            parsedArgs = JSON.parse(rawArgs);
          } catch (err: any) {
            const malformedErr = new Error(`Malformed tool arguments for ${name}: ${err?.message || String(err)}`);
            (malformedErr as any).errorCategory = 'malformed_tool_args';
            throw malformedErr;
          }
        } else if (typeof rawArgs === 'object' && rawArgs !== null) {
          parsedArgs = rawArgs as Record<string, unknown>;
        }

        const item: PlannerToolCall = {
          id: tc.id,
          name,
          arguments: parsedArgs,
        };
        parsedToolCalls.push(item);
        options?.onToolCall?.(item);
      }
    }

    const tokenCounts: PlannerTokenCounts | undefined = data.usage
      ? {
          prompt: data.usage.prompt_tokens,
          completion: data.usage.completion_tokens,
          cache: data.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined;

    const latencyMs = Date.now() - startTime;
    return {
      rawText,
      latencyMs,
      model: this.model,
      toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
      tokenCounts,
    };
  }
}
