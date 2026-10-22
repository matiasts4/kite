// Kite Code — OpenAiCompatPlannerProvider Tests (Level A / ODD Verification)
// Tests:
// - Streaming deltas & firstTokenMs
// - Native tool-call parsing (streaming and non-streaming)
// - Request cancellation via AbortSignal
// - Request timeout
// - Malformed tool arguments rejection and error categorization
// - Token counts extraction (prompt, completion, cache)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAiCompatPlannerProvider } from './openaiCompat';

describe('OpenAiCompatPlannerProvider — Streaming, Native Tool Calls & Resilience', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createSseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  it('renders first delta before completion and computes firstTokenMs', async () => {
    const ssePayload = [
      'data: {"choices":[{"delta":{"content":"Abriendo "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"terminales."}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
      'data: [DONE]\n\n',
    ];

    const mockResponse = new Response(createSseStream(ssePayload), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const provider = new OpenAiCompatPlannerProvider({
      id: 'test-opencode',
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4.1-flash',
    });

    const deltas: string[] = [];
    let firstTokenTime = 0;

    const result = await provider.plan(
      [{ role: 'user', content: 'abre 2 terminales' }],
      {
        stream: true,
        onDelta: (d) => deltas.push(d),
        onFirstToken: (ts) => {
          firstTokenTime = ts;
        },
      }
    );

    expect(deltas).toEqual(['Abriendo ', 'terminales.']);
    expect(firstTokenTime).toBeGreaterThan(0);
    expect(result.firstTokenMs).toBeDefined();
    expect(result.rawText).toBe('Abriendo terminales.');
    expect(result.tokenCounts?.prompt).toBe(10);
    expect(result.tokenCounts?.completion).toBe(5);
    expect(result.tokenCounts?.cache).toBe(3);
  });

  it('parses native tool calls from streaming chunks', async () => {
    const ssePayload = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"open_terminals","arguments":"{\\"count\\": 2"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":", \\"engine\\": \\"grok\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const mockResponse = new Response(createSseStream(ssePayload), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const provider = new OpenAiCompatPlannerProvider({
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4.1-flash',
    });

    const emittedTools: any[] = [];
    const result = await provider.plan(
      [{ role: 'user', content: 'abre 2 terminales con grok' }],
      {
        stream: true,
        onToolCall: (t) => emittedTools.push(t),
      }
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].name).toBe('open_terminals');
    expect(result.toolCalls?.[0].arguments).toEqual({ count: 2, engine: 'grok' });
    expect(emittedTools).toHaveLength(1);
  });

  it('parses native tool calls from non-streaming response', async () => {
    const jsonResponse = {
      choices: [
        {
          message: {
            content: 'Acción planificada.',
            tool_calls: [
              {
                id: 'call_close_1',
                type: 'function',
                function: {
                  name: 'close_terminals',
                  arguments: '{"target": "finished"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 8,
      },
    };

    const mockResponse = new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const provider = new OpenAiCompatPlannerProvider({
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4.1-flash',
    });

    const result = await provider.plan(
      [{ role: 'user', content: 'cierra las terminadas' }],
      { stream: false }
    );

    expect(result.rawText).toBe('Acción planificada.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].name).toBe('close_terminals');
    expect(result.toolCalls?.[0].arguments).toEqual({ target: 'finished' });
    expect(result.tokenCounts?.prompt).toBe(15);
  });

  it('rejects malformed tool arguments with errorCategory "malformed_tool_args"', async () => {
    const ssePayload = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"open_terminals","arguments":"{ invalid_json"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const mockResponse = new Response(createSseStream(ssePayload), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const provider = new OpenAiCompatPlannerProvider({
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4.1-flash',
    });

    await expect(
      provider.plan([{ role: 'user', content: 'abre terminales' }], { stream: true })
    ).rejects.toMatchObject({
      errorCategory: 'malformed_tool_args',
    });
  });

  it('cancels in-flight request when AbortSignal triggers', async () => {
    const abortController = new AbortController();

    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const provider = new OpenAiCompatPlannerProvider({
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4.1-flash',
    });

    const planPromise = provider.plan([{ role: 'user', content: 'ping' }], {
      signal: abortController.signal,
    });

    // Abort after 10ms
    setTimeout(() => abortController.abort(), 10);

    await expect(planPromise).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('aborts with timeout error when request exceeds timeoutSecs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('Request timed out'));
        });
      });
    });

    const provider = new OpenAiCompatPlannerProvider({
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4.1-flash',
    });

    await expect(
      provider.plan([{ role: 'user', content: 'sleep' }], { timeoutSecs: 0.05 })
    ).rejects.toThrow(/timed out/i);
  });
});
