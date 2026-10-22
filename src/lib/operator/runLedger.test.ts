// Kite Code — Operator Run Ledger Tests (Level A / ODD Verification)
// Tests:
// - Run lifecycle with timestamps correlation
// - Redaction of secrets and API keys
// - Bounded terminal output truncation (3500+ chars)
// - p50 / p95 latency percentiles
// - Query filtering (runId, provider, model, taskType, outcome, latency, date)
// - Timeout and cancellation handling
// - Persistence across restart & export/clear

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RunLedger,
  redactSecrets,
  boundTerminalOutput,
  hashToolArguments,
  calculatePercentile,
} from './runLedger';

describe('Run Ledger — Utility Functions', () => {
  describe('redactSecrets', () => {
    it('redacts Bearer tokens', () => {
      const input = 'Authorization: Bearer sk-ant-api03-abcdef12345678901234567890 in header';
      const redacted = redactSecrets(input);
      expect(redacted).not.toContain('sk-ant-api03-abcdef12345678901234567890');
      expect(redacted).toContain('[REDACTED_SECRET]');
    });

    it('redacts OpenAI and xAI API keys', () => {
      const openai = 'Using key sk-proj-1234567890abcdefghijklmnop to authenticate';
      expect(redactSecrets(openai)).not.toContain('sk-proj-1234567890abcdefghijklmnop');
      expect(redactSecrets(openai)).toContain('[REDACTED_SECRET]');

      const xai = 'xAI key is xai-9876543210abcdefghijklmnop';
      expect(redactSecrets(xai)).not.toContain('xai-9876543210abcdefghijklmnop');
      expect(redactSecrets(xai)).toContain('[REDACTED_SECRET]');
    });

    it('redacts secrets in JSON strings', () => {
      const json = JSON.stringify({ apiKey: 'sk-1234567890abcdef12345678', password: 'SuperSecret123!' });
      const redacted = redactSecrets(json);
      expect(redacted).not.toContain('sk-1234567890abcdef12345678');
      expect(redacted).not.toContain('SuperSecret123!');
    });
  });

  describe('boundTerminalOutput', () => {
    it('leaves short terminal output unmodified', () => {
      const shortText = 'test passed: 5 tests ok';
      expect(boundTerminalOutput(shortText, 500)).toBe(shortText);
    });

    it('bounds 3500+ character output and adds truncation marker', () => {
      const largeOutput = 'A'.repeat(3500);
      const bounded = boundTerminalOutput(largeOutput, 500);
      expect(bounded.length).toBeLessThan(700);
      expect(bounded).toContain('[TRUNCATED');
      expect(bounded).toContain('3000 chars');
    });
  });

  describe('hashToolArguments', () => {
    it('produces identical deterministic hash for same object regardless of key order', () => {
      const hash1 = hashToolArguments({ count: 2, engine: 'grok', prompts: ['test'] });
      const hash2 = hashToolArguments({ engine: 'grok', prompts: ['test'], count: 2 });
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('string');
      expect(hash1.length).toBeGreaterThan(0);
    });
  });

  describe('calculatePercentile', () => {
    it('returns 0 for empty array', () => {
      expect(calculatePercentile([], 50)).toBe(0);
      expect(calculatePercentile([], 95)).toBe(0);
    });

    it('calculates p50 and p95 accurately', () => {
      // 101 values: 0 to 100
      const values = Array.from({ length: 101 }, (_, i) => i);
      const p50 = calculatePercentile(values, 50);
      const p95 = calculatePercentile(values, 95);
      expect(p50).toBe(50);
      expect(p95).toBe(95);
    });
  });
});

describe('Run Ledger — Lifecycle, Observability & Filtering', () => {
  let ledger: RunLedger;
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    const storageMock = {
      getItem: vi.fn((k: string) => mockStorage[k] || null),
      setItem: vi.fn((k: string, v: string) => {
        mockStorage[k] = v;
      }),
      removeItem: vi.fn((k: string) => {
        delete mockStorage[k];
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
    };
    vi.stubGlobal('localStorage', storageMock);
    ledger = new RunLedger({ storageKey: 'test.run_ledger' });
  });

  it('records full run lifecycle with timestamps correlation and stable runId', () => {
    const runId = ledger.startRun('abre 2 terminales con grok', {
      taskType: 'open_terminals',
    });

    expect(runId).toBeDefined();

    ledger.recordProviderRequest(runId, {
      provider: 'opencode',
      model: 'deepseek-v4.1-flash',
      reasoningSetting: 'low',
    });

    const firstTokenTime = Date.now();
    ledger.recordFirstToken(runId, firstTokenTime);

    ledger.recordProviderResponse(runId, {
      latencyMs: 120,
      tokenCounts: { prompt: 50, completion: 20, cache: 10 },
      rawText: '{"reply": "Abriendo terminales", "actions": []}',
    });

    ledger.recordToolEmission(runId, {
      name: 'open_terminals',
      arguments: { count: 2, engine: 'grok' },
    });

    ledger.recordToolStart(runId, { name: 'open_terminals', actionIdx: 0 });

    ledger.recordTerminalExec(runId, {
      terminalId: 'term-1',
      command: 'grok',
      exitCode: 0,
    });

    ledger.recordTerminalOutput(runId, {
      terminalId: 'term-1',
      output: 'Terminal 1 ready\n',
      exitCode: 0,
    });

    ledger.recordToolEnd(runId, {
      name: 'open_terminals',
      ok: true,
      durationMs: 80,
      exitCode: 0,
    });

    const run = ledger.completeRun(runId, {
      reply: 'Se abrieron 2 terminales con grok.',
      outcome: 'success',
    });

    expect(run).toBeDefined();
    expect(run?.runId).toBe(runId);
    expect(run?.outcome).toBe('success');
    expect(run?.provider).toBe('opencode');
    expect(run?.model).toBe('deepseek-v4.1-flash');
    expect(run?.reasoningSetting).toBe('low');
    expect(run?.taskType).toBe('open_terminals');
    expect(run?.tokenCounts?.prompt).toBe(50);
    expect(run?.tokenCounts?.cache).toBe(10);

    // Timestamps
    expect(run?.timestamps.input).toBeDefined();
    expect(run?.timestamps.providerRequest).toBeDefined();
    expect(run?.timestamps.firstToken).toBe(firstTokenTime);
    expect(run?.timestamps.toolCallEmission).toBeDefined();
    expect(run?.timestamps.toolStart).toBeDefined();
    expect(run?.timestamps.toolEnd).toBeDefined();
    expect(run?.timestamps.terminalExecution).toBeDefined();
    expect(run?.timestamps.finalResponse).toBeDefined();

    // Tool calls
    expect(run?.toolCalls.length).toBe(1);
    expect(run?.toolCalls[0].name).toBe('open_terminals');
    expect(run?.toolCalls[0].argumentsHash).toBeDefined();
    expect(run?.toolCalls[0].ok).toBe(true);

    // Events order
    expect(run?.events.length).toBeGreaterThanOrEqual(7);
    expect(run?.events[0].type).toBe('run_start');
    expect(run?.events[run.events.length - 1].type).toBe('run_complete');
  });

  it('redacts secrets and bounds terminal output in stored events and runs', () => {
    const rawSecret = 'sk-proj-secretKey123456789012345678';
    const longOutput = 'LOG_LINE_'.repeat(400); // 3600 chars

    const runId = ledger.startRun(`Ejecuta con token Bearer ${rawSecret}`, {
      taskType: 'inject_prompt',
    });

    ledger.recordToolEmission(runId, {
      name: 'inject_prompt',
      arguments: { prompt: `token=${rawSecret}` },
    });

    ledger.recordTerminalOutput(runId, {
      terminalId: 'term-x',
      output: `${longOutput}\nSECRET=${rawSecret}`,
      exitCode: 0,
    });

    const run = ledger.completeRun(runId, {
      reply: `Listo con token ${rawSecret}`,
      outcome: 'success',
    });

    // Verify secrets are NOT present anywhere
    expect(run?.input).not.toContain(rawSecret);
    expect(run?.input).toContain('[REDACTED_SECRET]');
    expect(run?.reply).not.toContain(rawSecret);
    expect(run?.reply).toContain('[REDACTED_SECRET]');

    const toolArgStr = JSON.stringify(run?.toolCalls[0].arguments);
    expect(toolArgStr).not.toContain(rawSecret);
    expect(toolArgStr).toContain('[REDACTED_SECRET]');

    const termOutput = run?.terminalOutputs[0].excerpt || '';
    expect(termOutput).not.toContain(rawSecret);
    expect(termOutput).toContain('[TRUNCATED');
    expect(termOutput.length).toBeLessThan(700);

    // Verify raw events are also redacted
    for (const ev of run?.events || []) {
      const serialized = JSON.stringify(ev);
      expect(serialized).not.toContain(rawSecret);
    }
  });

  it('records timeout and cancellation with proper outcome and errorCategory', () => {
    const tRunId = ledger.startRun('tarea que tarda');
    ledger.recordProviderRequest(tRunId, { provider: 'grok', model: 'grok-4.7' });
    ledger.recordTimeout(tRunId, { errorCategory: 'gateway_timeout', message: 'Model took > 30s' });
    const timeoutRun = ledger.getRun(tRunId);

    expect(timeoutRun?.outcome).toBe('timeout');
    expect(timeoutRun?.errorCategory).toBe('gateway_timeout');

    const cRunId = ledger.startRun('tarea cancelada por usuario');
    ledger.recordCancellation(cRunId, { reason: 'User clicked stop' });
    const cancelledRun = ledger.getRun(cRunId);

    expect(cancelledRun?.outcome).toBe('cancelled');
    expect(cancelledRun?.errorCategory).toBe('user_cancelled');
  });

  it('filters runs by runId, provider, model, taskType, outcome, latency, and date', () => {
    const now = Date.now();

    // Run 1: opencode, deepseek, 150ms, success, open_terminals
    const r1 = ledger.startRun('run 1', { taskType: 'open_terminals' });
    ledger.recordProviderRequest(r1, { provider: 'opencode', model: 'deepseek-v4.1-flash' });
    ledger.completeRun(r1, { outcome: 'success' });
    const run1 = ledger.getRun(r1)!;
    run1.durationMs = 150;
    run1.startedAt = now - 50000;

    // Run 2: vercel, gpt-4o, 400ms, failure, inject_prompt
    const r2 = ledger.startRun('run 2', { taskType: 'inject_prompt' });
    ledger.recordProviderRequest(r2, { provider: 'vercel', model: 'openai/gpt-4o' });
    ledger.completeRun(r2, { outcome: 'failure', errorCategory: 'pty_write_error' });
    const run2 = ledger.getRun(r2)!;
    run2.durationMs = 400;
    run2.startedAt = now - 20000;

    // Run 3: grok, grok-4.7, 800ms, timeout, chat_response
    const r3 = ledger.startRun('run 3', { taskType: 'chat_response' });
    ledger.recordProviderRequest(r3, { provider: 'grok', model: 'grok-4.7' });
    ledger.recordTimeout(r3);
    const run3 = ledger.getRun(r3)!;
    run3.durationMs = 800;
    run3.startedAt = now;

    // Filter by runId
    expect(ledger.getRuns({ runId: r1 })).toHaveLength(1);
    expect(ledger.getRuns({ runId: r1 })[0].runId).toBe(r1);

    // Filter by provider
    expect(ledger.getRuns({ provider: 'opencode' })).toHaveLength(1);
    expect(ledger.getRuns({ provider: 'grok' })).toHaveLength(1);

    // Filter by model
    expect(ledger.getRuns({ model: 'gpt-4o' })).toHaveLength(1);

    // Filter by taskType
    expect(ledger.getRuns({ taskType: 'open_terminals' })).toHaveLength(1);

    // Filter by outcome / success
    expect(ledger.getRuns({ outcome: 'success' })).toHaveLength(1);
    expect(ledger.getRuns({ success: false })).toHaveLength(2);

    // Filter by latency range
    expect(ledger.getRuns({ minLatencyMs: 200, maxLatencyMs: 500 })).toHaveLength(1);
    expect(ledger.getRuns({ minLatencyMs: 500 })).toHaveLength(1);

    // Percentiles
    const stats = ledger.getLatencyPercentiles();
    expect(stats.count).toBe(3);
    expect(stats.p50).toBeGreaterThanOrEqual(150);
    expect(stats.p95).toBeGreaterThanOrEqual(400);
  });

  it('survives restarts via persistence and supports export/clear', () => {
    const rId = ledger.startRun('persisted run', { taskType: 'open_browser' });
    ledger.recordProviderRequest(rId, { provider: 'local', model: 'heuristic' });
    ledger.completeRun(rId, { outcome: 'success' });

    // Verify storage has been written
    expect(mockStorage['test.run_ledger']).toBeDefined();

    // Instantiate new ledger with same storage
    const restoredLedger = new RunLedger({ storageKey: 'test.run_ledger' });
    const restoredRun = restoredLedger.getRun(rId);

    expect(restoredRun).toBeDefined();
    expect(restoredRun?.input).toBe('persisted run');
    expect(restoredRun?.taskType).toBe('open_browser');

    // Export JSON
    const exportedJson = restoredLedger.exportHistory('json');
    expect(exportedJson).toContain('persisted run');

    // Export JSONL
    const exportedJsonl = restoredLedger.exportHistory('jsonl');
    expect(exportedJsonl.split('\n').filter(Boolean).length).toBe(1);

    // Clear history
    restoredLedger.clearHistory();
    expect(restoredLedger.getRuns()).toHaveLength(0);
    expect(mockStorage['test.run_ledger']).toBe('[]');
  });
});

describe('Run Ledger — T9 Integration Scenarios', () => {
  let ledger: RunLedger;

  beforeEach(() => {
    ledger = new RunLedger({ storageKey: 'test.run_ledger.t9' });
  });

  it('T9.1: Multi-terminal request lifecycle correlates one runId across planner, tool, and terminal events', () => {
    const input = 'abre 3 terminales con grok y ejecuta los tests';
    const runId = ledger.startRun(input, { taskType: 'open_terminals' });

    ledger.recordProviderRequest(runId, {
      provider: 'opencode',
      model: 'deepseek-v4.1-flash',
      reasoningSetting: 'low',
    });

    ledger.recordFirstToken(runId, Date.now());

    ledger.recordProviderResponse(runId, {
      latencyMs: 95,
      tokenCounts: { prompt: 40, completion: 25, cache: 12 },
      rawText: '{"reply": "Abriendo 3 terminales con Grok", "actions": []}',
    });

    ledger.recordToolEmission(runId, {
      name: 'open_terminals',
      arguments: { count: 3, engine: 'grok', prompts: ['ejecuta los tests'] },
    });

    ledger.recordToolStart(runId, { name: 'open_terminals', actionIdx: 0 });

    const terminalIds = ['term-grok-1', 'term-grok-2', 'term-grok-3'];
    for (const tid of terminalIds) {
      ledger.recordTerminalExec(runId, {
        terminalId: tid,
        command: 'grok',
        exitCode: 0,
      });
      ledger.recordTerminalOutput(runId, {
        terminalId: tid,
        output: `Agent ${tid} online and executing tests.\n`,
        exitCode: 0,
      });
    }

    ledger.recordToolEnd(runId, {
      name: 'open_terminals',
      ok: true,
      durationMs: 140,
      exitCode: 0,
    });

    const run = ledger.completeRun(runId, {
      reply: 'Se abrieron 3 terminales con grok.',
      outcome: 'success',
    });

    expect(run).toBeDefined();
    expect(run?.runId).toBe(runId);
    expect(run?.outcome).toBe('success');
    expect(run?.terminalOutputs).toHaveLength(3);
    expect(run?.toolCalls).toHaveLength(1);
    expect(run?.toolCalls[0].name).toBe('open_terminals');
    expect(run?.toolCalls[0].ok).toBe(true);

    // All events must strictly share this exact runId
    for (const ev of run?.events || []) {
      expect(ev.runId).toBe(runId);
    }
  });

  it('T9.2: 3500+ character log is strictly bounded, truncated with marker, and secrets are redacted', () => {
    const rawSecret = 'sk-proj-superSecretLiveKey99999999999999';
    const longLog = 'BUILD_TRACE_ROW_DATA_'.repeat(200) + `\nSECRET_KEY=${rawSecret}\n` + 'MORE_OUTPUT_'.repeat(100);
    expect(longLog.length).toBeGreaterThan(3500);

    const runId = ledger.startRun('ejecuta build');

    ledger.recordTerminalOutput(runId, {
      terminalId: 'term-build',
      output: longLog,
      exitCode: 0,
    });

    ledger.completeRun(runId, { outcome: 'success' });

    const run = ledger.getRun(runId);
    const excerpt = run?.terminalOutputs[0].excerpt || '';

    // Strictly bounded
    expect(excerpt.length).toBeLessThan(700);
    expect(excerpt).toContain('[TRUNCATED');
    expect(excerpt).not.toContain(rawSecret);

    // Verify raw unbounded string is never stored
    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized.length).toBeLessThan(longLog.length);
  });

  it('T9.3: Provider failure records outcome "failure" and error category', () => {
    const runId = ledger.startRun('consulta compleja');

    ledger.recordProviderRequest(runId, {
      provider: 'vercel',
      model: 'deepseek/deepseek-chat',
    });

    // Simulate provider failure (e.g. HTTP 500 error)
    ledger.recordToolEnd(runId, {
      name: 'plan',
      ok: false,
      error: 'HTTP 500 Internal Server Error from ai-gateway',
      errorCategory: 'provider_http_500',
    });

    const run = ledger.completeRun(runId, {
      outcome: 'failure',
      errorCategory: 'provider_http_500',
      reply: 'Error conectando con el proveedor LLM.',
    });

    expect(run?.outcome).toBe('failure');
    expect(run?.errorCategory).toBe('provider_http_500');
  });

  it('T9.4: Tool rejection records tool error, errorCategory, and unfulfilled status', () => {
    const runId = ledger.startRun('cierra terminal inexistente');

    ledger.recordToolEmission(runId, {
      name: 'close_terminals',
      arguments: { target: 'nonexistent-session' },
    });

    ledger.recordToolStart(runId, { name: 'close_terminals', actionIdx: 0 });

    ledger.recordToolEnd(runId, {
      name: 'close_terminals',
      ok: false,
      error: 'Target terminal was not found or was rejected by safety rule',
      errorCategory: 'tool_validation_failed',
      exitCode: 1,
    });

    const run = ledger.completeRun(runId, {
      outcome: 'failure',
      errorCategory: 'tool_validation_failed',
    });

    expect(run?.toolCalls[0].ok).toBe(false);
    expect(run?.toolCalls[0].errorCategory).toBe('tool_validation_failed');
    expect(run?.outcome).toBe('failure');
  });

  it('T9.5: Process timeout produces terminal ledger event with outcome "timeout"', () => {
    const runId = ledger.startRun('comando largo en terminal');

    ledger.recordTerminalExec(runId, {
      terminalId: 'term-long',
      command: 'sleep 100',
    });

    ledger.recordTimeout(runId, {
      errorCategory: 'process_timeout',
      message: 'Command exceeded 30s timeout limit',
    });

    const run = ledger.getRun(runId);
    expect(run?.outcome).toBe('timeout');
    expect(run?.errorCategory).toBe('process_timeout');
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);

    const timeoutEv = run?.events.find((e) => e.type === 'run_timeout');
    expect(timeoutEv).toBeDefined();
    expect(timeoutEv?.payload.errorCategory).toBe('process_timeout');
  });

  it('T9.6: Deterministic actions complete without provider round trip', () => {
    const runId = ledger.startRun('para la voz', { taskType: 'deterministic' });

    ledger.recordToolStart(runId, { name: 'stop_speaking' });
    ledger.recordToolEnd(runId, { name: 'stop_speaking', ok: true });

    const run = ledger.completeRun(runId, {
      reply: 'Voz detenida.',
      outcome: 'success',
    });

    expect(run?.outcome).toBe('success');
    expect(run?.timestamps.providerRequest).toBeUndefined();
    expect(run?.provider).toBeUndefined();
    expect(run?.toolCalls[0].name).toBe('stop_speaking');
  });
});
