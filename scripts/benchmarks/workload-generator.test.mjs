import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateProgressBar,
  generateTuiFrame,
  generateLogBurstChunk,
  generateAgentThoughtChunk,
} from './workload-generator.mjs';

test('generates consistent progress bar text', () => {
  const bar = generateProgressBar(50, 20);
  assert.ok(bar.includes('50.0%'));
  assert.ok(bar.includes('██████████'));
});

test('generates deterministic TUI frames with 80x24 layout', () => {
  const frame = generateTuiFrame(10, 1);
  assert.ok(frame.includes('KITE RUNTIME BENCHMARK E2-SPINNERS'));
  assert.ok(frame.includes('Pane 1'));
  const lines = frame.split('\r\n');
  assert.ok(lines.length >= 20);
});

test('generates logburst chunks with timestamps and ANSI markers', () => {
  const chunk = generateLogBurstChunk(5, 100);
  const lines = chunk.trim().split('\r\n');
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes('crate::terminal::pipeline'));
});

test('generates agent thought chunks with spinner glyphs', () => {
  const thought = generateAgentThoughtChunk(1);
  assert.ok(thought.includes('Agent thinking'));
  const diff = generateAgentThoughtChunk(15);
  assert.ok(diff.includes('@@'));
});
