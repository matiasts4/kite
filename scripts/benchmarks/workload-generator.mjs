#!/usr/bin/env node
/**
 * Deterministic ANSI Workload Generator for Terminal Benchmark Scenarios
 * Supports:
 *   - spinners: 80x24 TUI with spinner glyphs and progress bars updating every 16ms
 *   - logburst: scrolling colored build log lines at 2,000 lines/sec per pane
 *   - idle: prompt only, 0 output
 *   - agents: agent thinking spinners, streaming markdown diffs, tool dispatch
 */

const BRAILLE_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_MAGENTA = '\x1b[35m';
const ANSI_BLUE = '\x1b[34m';
const ANSI_GRAY = '\x1b[90m';

export function generateProgressBar(percent, width = 30) {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent.toFixed(1)}%`;
}

export function generateTuiFrame(tick, paneId = 1) {
  const spinnerChar = BRAILLE_SPINNER[tick % BRAILLE_SPINNER.length];
  const progress1 = (tick * 0.8) % 100;
  const progress2 = (tick * 1.4) % 100;
  const elapsedSec = (tick * 0.016).toFixed(1);

  const lines = [
    `\x1b[H\x1b[2J${ANSI_BOLD}${ANSI_CYAN}=== KITE RUNTIME BENCHMARK E2-SPINNERS (Pane ${paneId}) ===${ANSI_RESET}`,
    `${ANSI_GRAY}Deterministic TUI Generator (16ms clock) | Elapsed: ${elapsedSec}s${ANSI_RESET}`,
    '',
    `${ANSI_YELLOW}${spinnerChar} Task A: Running compilation pass...${ANSI_RESET}`,
    `  ${ANSI_GREEN}${generateProgressBar(progress1, 35)}${ANSI_RESET}`,
    '',
    `${ANSI_MAGENTA}${spinnerChar} Task B: Streaming agent inference delta...${ANSI_RESET}`,
    `  ${ANSI_BLUE}${generateProgressBar(progress2, 35)}${ANSI_RESET}`,
    '',
    `${ANSI_BOLD}Worker Status:${ANSI_RESET}`,
    `  • Worker 1: ${ANSI_GREEN}ACTIVE${ANSI_RESET} (PID 4120, IO: 42 KB/s)`,
    `  • Worker 2: ${ANSI_GREEN}ACTIVE${ANSI_RESET} (PID 4128, IO: 88 KB/s)`,
    `  • PTY Channel: #${paneId} @ 30 FPS target`,
    '',
    `${ANSI_GRAY}Active threads: 8 | Coalesce interval: 33ms${ANSI_RESET}`,
    `${ANSI_GRAY}Deterministic tick: #${tick}${ANSI_RESET}`,
    '',
  ];

  while (lines.length < 23) {
    lines.push(`${ANSI_GRAY}~${ANSI_RESET}`);
  }
  lines.push(`\r\x1b[K${ANSI_CYAN}${spinnerChar} Status: OK${ANSI_RESET} (press Ctrl+C to abort)`);

  return lines.join('\r\n');
}

export function generateLogBurstChunk(batchSize = 20, baseIndex = 0) {
  const lines = [];
  for (let i = 0; i < batchSize; i++) {
    const idx = baseIndex + i;
    const kind = idx % 10 === 0 ? 'WARN' : 'INFO';
    const color = kind === 'WARN' ? ANSI_YELLOW : ANSI_GREEN;
    const ts = new Date().toISOString().slice(11, 23);
    lines.push(
      `[${ts}] ${color}[${kind}]${ANSI_RESET} ${ANSI_CYAN}crate::terminal::pipeline${ANSI_RESET} processed frame chunk #${idx} (bytes=${(idx * 64) % 4096})`
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export function generateAgentThoughtChunk(step) {
  const spinnerChar = BRAILLE_SPINNER[step % BRAILLE_SPINNER.length];
  if (step % 15 === 0) {
    return (
      `\r\n${ANSI_BOLD}${ANSI_MAGENTA}@@ -104,8 +104,12 @@ export function processToken() {${ANSI_RESET}\r\n` +
      `${ANSI_GREEN}+  const optimized = fastDecode(chunk);${ANSI_RESET}\r\n` +
      `${ANSI_GREEN}+  return attachObservedBytes(optimized);${ANSI_RESET}\r\n` +
      `   const fallback = standardDecode(chunk);\r\n`
    );
  }
  return `\r\x1b[K${ANSI_CYAN}${spinnerChar} Agent thinking:${ANSI_RESET} exploring branch AST step #${step}...`;
}

export async function runWorkload(mode, durationSec = 60, paneId = 1) {
  const startTime = Date.now();
  const endTime = startTime + durationSec * 1000;
  let tick = 0;

  if (mode === 'idle') {
    process.stdout.write(`\r\nkite-code@benchmark-pane-${paneId}:~$ `);
    await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
    return;
  }

  if (mode === 'spinners') {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (Date.now() >= endTime) {
          clearInterval(interval);
          process.stdout.write(`\r\n\x1b[32m[Benchmark Complete]\x1b[0m\r\n`);
          resolve();
          return;
        }
        tick++;
        process.stdout.write(generateTuiFrame(tick, paneId));
      }, 16);
    });
  }

  if (mode === 'logburst') {
    // 2,000 lines/sec = 20 lines every 10ms
    let lineIdx = 0;
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (Date.now() >= endTime) {
          clearInterval(interval);
          process.stdout.write(`\r\n\x1b[32m[Benchmark Complete]\x1b[0m\r\n`);
          resolve();
          return;
        }
        process.stdout.write(generateLogBurstChunk(20, lineIdx));
        lineIdx += 20;
      }, 10);
    });
  }

  if (mode === 'agents') {
    let step = 0;
    process.stdout.write(`\x1b]7501;state=working:app=kite\x1b\\`);
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (Date.now() >= endTime) {
          clearInterval(interval);
          process.stdout.write(`\r\n\x1b]7501;state=idle:app=kite\x1b\\\x1b[32m[Agent Complete]\x1b[0m\r\n`);
          resolve();
          return;
        }
        step++;
        process.stdout.write(generateAgentThoughtChunk(step));
      }, 50);
    });
  }

  throw new Error(`Unknown mode: ${mode}`);
}

// CLI direct execution
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const mode = process.argv[2] || 'spinners';
  const duration = parseInt(process.argv[3] || '60', 10);
  const pane = parseInt(process.argv[4] || '1', 10);
  runWorkload(mode, duration, pane).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
