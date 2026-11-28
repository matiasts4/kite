import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TAP_HOLD_THRESHOLD_MS,
  DEFAULT_TEXT_SYNC_BATCH_MS,
  HybridPttController,
  InCallTextSyncBatcher,
  isEditableTargetWithText,
  type CoalescedTextTurnPayload,
} from './pttController';

describe('T6 / S4.1 — HybridPttController (Tap-vs-Hold 500ms) & InCallTextSyncBatcher (250ms)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('HybridPttController', () => {
    it('exports TAP_HOLD_THRESHOLD_MS = 500 and handles >= 500ms hold-to-talk release', () => {
      expect(TAP_HOLD_THRESHOLD_MS).toBe(500);

      const onStartCapture = vi.fn();
      const onStopCapture = vi.fn();
      const ptt = new HybridPttController({ onStartCapture, onStopCapture });

      expect(ptt.handleKeyDown(1000)).toBe(true);
      expect(onStartCapture).toHaveBeenCalledTimes(1);
      expect(ptt.getState()).toMatchObject({
        mode: 'hold-to-talk',
        isCapturing: true,
        isKeyPressed: true,
      });

      // Exactly 500ms -> hold-to-talk stops immediately on release
      const outcome = ptt.handleKeyUp(1500);
      expect(outcome).toEqual({
        action: 'stopped-hold',
        mode: 'idle',
        isCapturing: false,
        heldMs: 500,
      });
      expect(onStopCapture).toHaveBeenCalledWith('hold-release');
      expect(ptt.getState()).toMatchObject({
        mode: 'idle',
        isCapturing: false,
        isKeyPressed: false,
      });
    });

    it('handles < 500ms tap-to-toggle: starts on first tap and stops on second tap', () => {
      const onStartCapture = vi.fn();
      const onStopCapture = vi.fn();
      const ptt = new HybridPttController({ onStartCapture, onStopCapture });

      // First short tap (180ms < 500ms) -> stays active in tap-to-toggle mode
      expect(ptt.handleKeyDown(1000)).toBe(true);
      const tapOn = ptt.handleKeyUp(1180);
      expect(tapOn).toEqual({
        action: 'toggled-on',
        mode: 'tap-to-toggle',
        isCapturing: true,
        heldMs: 180,
      });
      expect(onStartCapture).toHaveBeenCalledTimes(1);
      expect(onStopCapture).not.toHaveBeenCalled();

      // Second short tap (140ms < 500ms) -> toggles off cleanly
      expect(ptt.handleKeyDown(2000)).toBe(true);
      expect(onStartCapture).toHaveBeenCalledTimes(1);
      const tapOff = ptt.handleKeyUp(2140);
      expect(tapOff).toEqual({
        action: 'toggled-off',
        mode: 'idle',
        isCapturing: false,
        heldMs: 140,
      });
      expect(onStopCapture).toHaveBeenCalledWith('tap-toggle-off');
    });

    it('ignores auto-repeat keydown events without resetting hold timer or double-starting', () => {
      const onStartCapture = vi.fn();
      const onStopCapture = vi.fn();
      const ptt = new HybridPttController({ onStartCapture, onStopCapture });

      expect(ptt.handleKeyDown(1000, { repeat: false })).toBe(true);
      expect(ptt.handleKeyDown(1250, { repeat: true })).toBe(false);
      expect(ptt.handleKeyDown(1450, { repeat: true })).toBe(false);
      expect(onStartCapture).toHaveBeenCalledTimes(1);

      // Releasing at 1550 measures from original keydown at 1000 (550ms >= 500ms)
      const outcome = ptt.handleKeyUp(1550);
      expect(outcome.action).toBe('stopped-hold');
      expect(outcome.heldMs).toBe(550);
      expect(onStopCapture).toHaveBeenCalledWith('hold-release');
    });

    it('ignores Spacebar when focus is inside an editable input/textarea with non-empty text, but allows empty inputs', () => {
      const onStartCapture = vi.fn();
      const ptt = new HybridPttController({ onStartCapture });

      expect(
        ptt.handleKeyDown(1000, {
          target: { tagName: 'INPUT', type: 'text', value: 'hola argos' },
        })
      ).toBe(false);
      expect(
        ptt.handleKeyDown(1010, {
          target: { tagName: 'TEXTAREA', value: 'borrador pendiente' },
        })
      ).toBe(false);
      expect(
        ptt.handleKeyDown(1020, {
          target: { tagName: 'DIV', isContentEditable: true, textContent: 'editando' },
        })
      ).toBe(false);
      expect(onStartCapture).not.toHaveBeenCalled();

      // Empty input / textarea should allow PTT activation
      expect(
        ptt.handleKeyDown(1030, {
          target: { tagName: 'INPUT', type: 'text', value: '' },
        })
      ).toBe(true);
      expect(onStartCapture).toHaveBeenCalledTimes(1);

      expect(isEditableTargetWithText({ tagName: 'INPUT', type: 'checkbox', value: 'on' })).toBe(false);
    });

    it('stops capture on handleBlur while in hold mode so a stuck key never leaves the mic open', () => {
      const onStartCapture = vi.fn();
      const onStopCapture = vi.fn();
      const ptt = new HybridPttController({ onStartCapture, onStopCapture });

      ptt.handleKeyDown(1000);
      expect(ptt.getState().isCapturing).toBe(true);

      // Window blurs before keyup arrives
      expect(ptt.handleBlur()).toBe(true);
      expect(onStopCapture).toHaveBeenCalledWith('blur');
      expect(ptt.getState()).toMatchObject({
        mode: 'idle',
        isCapturing: false,
        isKeyPressed: false,
      });

      // Late keyup after blur is safely ignored
      expect(ptt.handleKeyUp(2000).action).toBe('none');
    });

    it('keeps tap-to-toggle capture alive on blur when no key is currently held down', () => {
      const onStopCapture = vi.fn();
      const ptt = new HybridPttController({ onStopCapture });

      ptt.handleKeyDown(1000);
      ptt.handleKeyUp(1150);
      expect(ptt.getState().mode).toBe('tap-to-toggle');

      expect(ptt.handleBlur()).toBe(false);
      expect(onStopCapture).not.toHaveBeenCalled();
      expect(ptt.getState().isCapturing).toBe(true);
    });
  });

  describe('InCallTextSyncBatcher', () => {
    it('exports DEFAULT_TEXT_SYNC_BATCH_MS = 250 and coalesces rapid messages + attachments into one payload', () => {
      expect(DEFAULT_TEXT_SYNC_BATCH_MS).toBe(250);

      const flushed: CoalescedTextTurnPayload[] = [];
      const batcher = new InCallTextSyncBatcher({
        onFlush: (payload) => {
          flushed.push(payload);
        },
      });

      expect(batcher.enqueue('revisa auth', [{ id: 'f1', path: 'src/auth.ts' }], 100)).toBe(true);
      vi.advanceTimersByTime(100);
      expect(flushed).toHaveLength(0);

      // Rapid follow-up with duplicate attachment + second attachment within 250ms window
      expect(
        batcher.enqueue(
          'y también los tests',
          [
            { id: 'f1', path: 'src/auth.ts' },
            { id: 'f2', path: 'src/auth.test.ts' },
          ],
          200
        )
      ).toBe(true);

      vi.advanceTimersByTime(249);
      expect(flushed).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(flushed).toHaveLength(1);
      expect(flushed[0]).toMatchObject({
        text: 'revisa auth\ny también los tests',
        messages: ['revisa auth', 'y también los tests'],
        attachments: [
          { id: 'f1', path: 'src/auth.ts' },
          { id: 'f2', path: 'src/auth.test.ts' },
        ],
        count: 2,
        firstEnqueuedAt: 100,
      });
      expect(batcher.hasPending()).toBe(false);
    });

    it('supports manual flush() and attachment-only submissions', () => {
      const onFlush = vi.fn();
      const batcher = new InCallTextSyncBatcher({ onFlush });

      expect(batcher.flush()).toBeNull();
      expect(batcher.enqueue('   ', [{ path: 'odd/tasks/spec.md', name: 'spec.md' }], 50)).toBe(true);
      expect(batcher.getPendingCount()).toBe(1);

      const payload = batcher.flush(120);
      expect(payload).toEqual({
        text: '',
        messages: [],
        attachments: [{ path: 'odd/tasks/spec.md', name: 'spec.md' }],
        count: 1,
        firstEnqueuedAt: 50,
        flushedAt: 120,
      });
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(batcher.hasPending()).toBe(false);
    });

    it('ignores blank submissions and cancels pending timer on dispose()', () => {
      const onFlush = vi.fn();
      const batcher = new InCallTextSyncBatcher({ onFlush });

      expect(batcher.enqueue('   ', [])).toBe(false);
      expect(batcher.enqueue('mensaje pendiente', [])).toBe(true);

      batcher.dispose();
      vi.advanceTimersByTime(500);
      expect(onFlush).not.toHaveBeenCalled();
      expect(batcher.enqueue('después de dispose', [])).toBe(false);
    });
  });
});
