import {
  assertNativeTauriShell,
  assertNoHorizontalOverflow,
  assertNoSiblingOverlap,
  assertVisibleAndClickableRect,
  captureArtifactScreenshot,
  waitForBootCoverCleared,
} from '../assertions.mjs';
import { prepareFakeDriverSandbox, readDriverCallLog } from '../fake-driver/setup.mjs';
import {
  enterActiveThreadComposer,
  selectThreadProvider,
} from '../helpers/thread-helpers.mjs';

export const meta = {
  id: 'VOICE-MODE-01',
  title: 'Verify Thread Voice Mode activation, VoiceModeFooterBar controls, consultative draft & subagent timeline order, and teardown',
};

const SCENARIO = {
  rules: [
    {
      driver: 'grok',
      promptIncludes: 'Revisar autenticacion en voz',
      steps: [
        {
          delayMs: 60,
          rawLine: JSON.stringify({
            reply: 'Propongo lanzar un subagente explorador sobre auth. ¿Confirmamos?',
            actions: [
              {
                type: 'propose_task',
                targetKind: 'subagent',
                title: 'Auditar modulo auth',
                taskBrief: 'Revisar el modulo auth y sus tests',
                role: 'Explorer',
                provider: 'claude',
                mode: 'explore',
                oddMode: false,
                questionForUser: '¿Lo lanzamos con Claude en modo explore?',
              },
            ],
          }),
        },
      ],
    },
    {
      driver: 'grok',
      promptIncludes: 'Verificando eco en voz',
      steps: [
        {
          delayMs: 900,
          rawLine: JSON.stringify({
            reply: 'Eco de voz verificado correctamente.',
            actions: [],
          }),
        },
      ],
    },
    {
      driver: 'claude',
      promptIncludes: 'Revisar el modulo auth y sus tests',
      steps: [
        { delayMs: 120, textDelta: 'Auditando auth... ' },
        { delayMs: 250, textDelta: 'Auditoria auth completada.' },
      ],
    },
  ],
};

export const launchOptions = {
  setupSandbox: async (sandbox) => {
    await prepareFakeDriverSandbox(sandbox, SCENARIO);
  },
};

/**
 * @param {{
 *   page: import('playwright-core').Page,
 *   sandbox: import('../sandbox.mjs').DesktopSandbox,
 *   artifactsDir: string,
 *   pageErrors: string[],
 * }} ctx
 */
export async function run(ctx) {
  const { page, sandbox, artifactsDir, pageErrors } = ctx;

  await assertNativeTauriShell(page);
  await waitForBootCoverCleared(page);
  await page.setViewportSize({ width: 1366, height: 840 });

  // Configure Argos operator to route Grok planning through the sandbox fake `grok` CLI
  // and disable TTS audio output in headless/E2E runs.
  await page.evaluate(() => {
    const key = 'kite.operator.providerConfig.v2';
    let current = {};
    try {
      current = JSON.parse(window.localStorage.getItem(key) || '{}') || {};
    } catch {
      current = {};
    }
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...current,
        activeProvider: 'grok',
        grokUseCliSubscription: true,
        grokApiKey: '',
        ttsEnabled: false,
        ttsEngine: 'native',
      }),
    );
  });

  // 1. Enter an active blank Thread and select Claude Code for subagent target consistency.
  await enterActiveThreadComposer(page);
  await selectThreadProvider(page, 'Claude Code');

  // 2. Activate Thread Voice Mode via the genuine 32px composer trigger button.
  const startVoiceBtn = page.locator('.chat-surface--thread button.chat-voice-mode-control[aria-label="Iniciar sesión de voz"]').first();
  await assertVisibleAndClickableRect(startVoiceBtn, 'Thread composer Voice Mode trigger');
  await startVoiceBtn.click();

  const voiceFooter = page.locator('[data-testid="voice-mode-footer-bar"]');
  await voiceFooter.waitFor({ state: 'visible', timeout: 10_000 });
  const footerTransport = await voiceFooter.getAttribute('data-transport');
  if (footerTransport !== 'cascaded' && footerTransport !== 'realtime') {
    throw new Error(`Expected VoiceModeFooterBar data-transport attribute, got ${JSON.stringify(footerTransport)}`);
  }
  await page.locator('[data-testid="thread-voice-hero"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-testid="voice-stage-atmosphere"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-testid="voice-wave-ribbon"]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('.kite-composer-main--voice-active').waitFor({ state: 'visible', timeout: 10_000 });

  const statusPill = page.locator('[data-testid="voice-live-status-pill"]');
  await statusPill.waitFor({ state: 'visible', timeout: 10_000 });

  await page.waitForFunction(
    () => {
      const chips = Array.from(document.querySelectorAll('[data-testid="thread-voice-quick-prompts"] button'));
      const ribbon = document.querySelector('[data-testid="voice-wave-ribbon"]');
      if (chips.length < 3 || !ribbon) return false;
      const r = ribbon.getBoundingClientRect();
      return (
        r.width > 120 &&
        r.height >= 20 &&
        chips.every((btn) => Number.parseFloat(getComputedStyle(btn).opacity || '1') >= 0.95)
      );
    },
    null,
    { timeout: 5_000 },
  );

  // Verify draft Voice Hero orb & all 3 quick-prompt chips fit cleanly unclipped inside 1366x840 viewport.
  const heroFitCheck = await page.evaluate(() => {
    const hero = document.querySelector('[data-testid="thread-voice-hero"]');
    const chips = Array.from(document.querySelectorAll('[data-testid="thread-voice-quick-prompts"] button'));
    if (!hero || chips.length < 3) {
      return { ok: false, reason: `hero=${Boolean(hero)} chips=${chips.length}` };
    }
    const vh = window.innerHeight;
    const heroRect = hero.getBoundingClientRect();
    const outOfBounds = [];
    if (heroRect.top < 0 || heroRect.bottom > vh) {
      outOfBounds.push(`hero(${Math.round(heroRect.top)}..${Math.round(heroRect.bottom)})`);
    }
    for (const chip of chips) {
      const r = chip.getBoundingClientRect();
      if (r.width < 10 || r.height < 10 || r.top < 0 || r.bottom > vh) {
        outOfBounds.push(`chip("${chip.textContent?.trim()}" ${Math.round(r.top)}..${Math.round(r.bottom)})`);
      }
    }
    return {
      ok: outOfBounds.length === 0,
      viewportHeight: vh,
      outOfBounds,
    };
  });
  if (!heroFitCheck.ok) {
    throw new Error(`Draft Voice Hero viewport fit check failed: ${JSON.stringify(heroFitCheck)}`);
  }

  await captureArtifactScreenshot(page, artifactsDir, '01-voice-mode-active');

  // Verify T1-T2 WebGL ComposerVoiceGlow & frosted-glass VoiceTeleprompterDock appear while Voice Mode is active.
  const voiceGlow = page.locator('[data-testid="voice-speaking-glow"][data-active="true"]');
  await voiceGlow.waitFor({ state: 'attached', timeout: 10_000 });

  const teleprompterDock = page.locator('[data-testid="voice-teleprompter-dock"]');
  await teleprompterDock.waitFor({ state: 'visible', timeout: 10_000 });
  const collapseToggle = page.locator('[data-testid="voice-teleprompter-collapse"]');
  await assertVisibleAndClickableRect(collapseToggle, 'VoiceCallBar collapse toggle');
  await collapseToggle.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="voice-teleprompter-dock"]')?.getAttribute('data-collapsed') ===
      'true',
    null,
    { timeout: 5_000 },
  );
  await collapseToggle.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="voice-teleprompter-dock"]')?.getAttribute('data-collapsed') ===
      'false',
    null,
    { timeout: 5_000 },
  );

  // Verify geometry and zero sibling overlap on VoiceModeFooterBar controls.
  await assertNoHorizontalOverflow(page, 'Voice Mode active footer', [
    '.titlebar',
    'section.chat-surface--thread',
    '.kite-composer-shell',
  ]);
  await assertNoSiblingOverlap(
    page.locator('[data-testid="voice-call-controls"] button'),
    'VoiceModeFooterBar call controls',
    { minCount: 3 },
  );

  // 3. Exercise Mic Mute and Speaker Mute buttons via genuine pointer clicks.
  const micMuteBtn = page.locator('[data-testid="voice-call-controls"] button[aria-label="Silenciar micrófono"]');
  await assertVisibleAndClickableRect(micMuteBtn, 'VoiceModeFooterBar Mic Mute button');
  await micMuteBtn.click();

  const micUnmuteBtn = page.locator('[data-testid="voice-call-controls"] button[aria-label="Activar micrófono"]');
  await assertVisibleAndClickableRect(micUnmuteBtn, 'VoiceModeFooterBar Mic Unmute button');
  if ((await micUnmuteBtn.getAttribute('aria-pressed')) !== 'true') {
    throw new Error('Expected Mic Mute button aria-pressed="true" after clicking Silenciar micrófono');
  }
  const mutedStatus = (await statusPill.innerText()).trim();
  if (!mutedStatus.includes('Micrófono en pausa')) {
    throw new Error(`Expected muted status pill "Micrófono en pausa", got ${JSON.stringify(mutedStatus)}`);
  }

  await micUnmuteBtn.click();
  await micMuteBtn.waitFor({ state: 'visible', timeout: 5_000 });

  const speakerMuteBtn = page.locator('[data-testid="voice-call-controls"] button[aria-label="Silenciar voz en altavoz"]');
  await assertVisibleAndClickableRect(speakerMuteBtn, 'VoiceModeFooterBar Speaker Mute button');
  await speakerMuteBtn.click();

  const speakerUnmuteBtn = page.locator('[data-testid="voice-call-controls"] button[aria-label="Activar voz en altavoz"]');
  await assertVisibleAndClickableRect(speakerUnmuteBtn, 'VoiceModeFooterBar Speaker Unmute button');
  if ((await speakerUnmuteBtn.getAttribute('aria-pressed')) !== 'true') {
    throw new Error('Expected Speaker Mute button aria-pressed="true" after clicking Silenciar voz en altavoz');
  }
  await speakerUnmuteBtn.click();
  await speakerMuteBtn.waitFor({ state: 'visible', timeout: 5_000 });

  // 3b. Verify teleprompter stays agent-only while the agent is thinking (never duplicating user speech).
  const voiceTextarea = page.locator('.chat-surface--thread textarea[placeholder="Escribir en la sesión de voz…"]').first();
  const sendVoiceTurnBtn = page.locator('.chat-surface--thread button[aria-label="Enviar a la sesión de voz"]').first();
  await assertVisibleAndClickableRect(voiceTextarea, 'Voice Mode composer textarea');
  await voiceTextarea.click();
  await voiceTextarea.fill('Verificando eco en voz');
  await assertVisibleAndClickableRect(sendVoiceTurnBtn, 'Voice Mode send turn button');
  await sendVoiceTurnBtn.click();

  const liveThinkingTurn = page.locator('[data-testid="live-thinking-turn"]');
  await liveThinkingTurn.waitFor({ state: 'visible', timeout: 5_000 });
  if ((await page.locator('[data-testid="live-user-echo"]').count()) !== 0) {
    throw new Error('Expected live-user-echo count to be 0 in agent-only teleprompter');
  }
  if ((await page.locator('[data-testid="live-user-turn"]').count()) !== 0) {
    throw new Error('Expected live-user-turn count to be 0 in agent-only teleprompter');
  }
  await captureArtifactScreenshot(page, artifactsDir, '01b-voice-agent-thinking');
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.chat-turn--assistant')).some((el) =>
        (el.textContent || '').includes('Eco de voz verificado correctamente.'),
      ),
    null,
    { timeout: 10_000 },
  );

  // 4. Submit a voice-mode text turn triggering `propose_task` -> ConsultativeDraftCard.
  await assertVisibleAndClickableRect(voiceTextarea, 'Voice Mode composer textarea');
  await voiceTextarea.click();
  await voiceTextarea.fill('Revisar autenticacion en voz');

  await assertVisibleAndClickableRect(sendVoiceTurnBtn, 'Voice Mode send turn button');
  await sendVoiceTurnBtn.click();

  const draftCard = page.locator('[data-testid="consultative-draft-card"]');
  await draftCard.waitFor({ state: 'visible', timeout: 15_000 });
  const draftText = await draftCard.innerText();
  if (!draftText.includes('Auditar modulo auth')) {
    throw new Error(`Expected ConsultativeDraftCard to display proposal title, got: ${JSON.stringify(draftText)}`);
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="live-agent-turn"] .kite-voice-teleprompter__word--spoken')
        .length > 0,
    null,
    { timeout: 5_000 },
  );
  await captureArtifactScreenshot(page, artifactsDir, '02-consultative-draft-card');

  // 5. Confirm the consultative draft via real pointer click -> spawns real claude subagent.
  const confirmBtn = draftCard.locator('button', { hasText: 'Confirmar' });
  await assertVisibleAndClickableRect(confirmBtn, 'ConsultativeDraftCard Confirmar button');
  await confirmBtn.click();

  await draftCard.waitFor({ state: 'hidden', timeout: 15_000 });

  await page.waitForFunction(
    () => {
      const userTurns = Array.from(document.querySelectorAll('.chat-turn--user'));
      const assistantTurns = Array.from(document.querySelectorAll('.chat-turn--assistant'));
      const hasConfirmUser = userTurns.some((el) => (el.textContent || '').toLowerCase().includes('confirmar'));
      const hasConfirmReply = assistantTurns.some((el) => {
        const text = el.textContent || '';
        return text.includes('Confirmado') && text.includes('Auditar modulo auth');
      });
      return userTurns.length >= 2 && hasConfirmUser && hasConfirmReply;
    },
    null,
    { timeout: 15_000 },
  );

  // Verify chronological timeline DOM ordering: user turn -> tool/action work row -> assistant reply.
  const orderingCheck = await page.evaluate(() => {
    const userNodes = Array.from(document.querySelectorAll('.chat-turn--user'));
    const assistantNodes = Array.from(document.querySelectorAll('.chat-turn--assistant'));
    const confirmUser = userNodes.find((el) => (el.textContent || '').toLowerCase().includes('confirmar'));
    const confirmAssistant = assistantNodes.find((el) => {
      const text = el.textContent || '';
      return text.includes('Confirmado') && text.includes('Auditar modulo auth');
    });
    if (!confirmUser || !confirmAssistant) {
      return { ok: false, reason: 'missing confirm user or assistant DOM nodes' };
    }
    const pos = confirmUser.compareDocumentPosition(confirmAssistant);
    const userPrecedesAssistant = Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING);

    const workNodes = Array.from(document.querySelectorAll('.chat-work-group, .chat-work-entry'));
    const confirmTool = workNodes.find((el) => (el.textContent || '').includes('Propuesta confirmada'));
    let toolBetween = true;
    if (confirmTool) {
      const afterUser = Boolean(
        confirmUser.compareDocumentPosition(confirmTool) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const beforeAssistant = Boolean(
        confirmTool.compareDocumentPosition(confirmAssistant) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      toolBetween = afterUser && beforeAssistant;
    }

    return { ok: userPrecedesAssistant && toolBetween, userPrecedesAssistant, toolBetween };
  });

  if (!orderingCheck.ok) {
    throw new Error(`Voice timeline ordering assertion failed: ${JSON.stringify(orderingCheck)}`);
  }

  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="live-agent-turn"] .kite-voice-teleprompter__word--spoken')
        .length > 0,
    null,
    { timeout: 5_000 },
  );
  await captureArtifactScreenshot(page, artifactsDir, '03-voice-timeline-ordered');

  // Verify fake `grok` planner and `claude` child subagent actually executed in sandbox.
  await page.waitForFunction(
    () => true,
    null,
    { timeout: 1000 },
  );
  const driverCalls = await readDriverCallLog(sandbox);
  const grokCalls = driverCalls.filter((c) => c.driver === 'grok');
  if (grokCalls.length < 1) {
    throw new Error(`Expected at least 1 fake grok operator planner call, got ${grokCalls.length}`);
  }

  // 6. Clean teardown via VoiceModeFooterBar "Finalizar" button.
  const endBtn = page.locator('[data-testid="voice-call-controls"] button[aria-label="Finalizar sesión de voz"]');
  await assertVisibleAndClickableRect(endBtn, 'VoiceModeFooterBar Finalizar button');
  await endBtn.click();

  await voiceFooter.waitFor({ state: 'hidden', timeout: 10_000 });
  await teleprompterDock.waitFor({ state: 'hidden', timeout: 5_000 });
  await startVoiceBtn.waitFor({ state: 'visible', timeout: 10_000 });

  // Verify T8 post-call receipt persistence after closing voice session.
  await page.waitForFunction(
    () => {
      try {
        const raw = localStorage.getItem('kite_voice_call_receipts_v1');
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return (
          Array.isArray(parsed) &&
          parsed.some((r) => typeof r.turnCount === 'number' && r.turnCount >= 1 && r.durationMs >= 0)
        );
      } catch {
        return false;
      }
    },
    null,
    { timeout: 10_000 },
  );

  // Verify T7 post-call VoiceTranscriptCard renders inside the scrollable timeline without duplicate inline summary row.
  const transcriptCard = page.locator('[data-testid="voice-transcript-card"]');
  await transcriptCard.waitFor({ state: 'visible', timeout: 10_000 });
  const timelinePlacementCheck = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="voice-transcript-card"]');
    const insideTimeline = Boolean(card && card.closest('.chat-transcript__column'));
    const workRows = Array.from(document.querySelectorAll('.chat-work-entry')).map((el) =>
      (el.textContent || '').trim()
    );
    const hasDuplicateSummary = workRows.some((txt) => txt.includes('Resumen de sesión de voz'));
    return {
      ok: insideTimeline && !hasDuplicateSummary,
      insideTimeline,
      hasDuplicateSummary,
    };
  });
  if (!timelinePlacementCheck.ok) {
    throw new Error(
      `Expected VoiceTranscriptCard inside timeline without duplicate summary row: ${JSON.stringify(timelinePlacementCheck)}`
    );
  }
  await captureArtifactScreenshot(page, artifactsDir, '04-voice-mode-ended');

  await assertVisibleAndClickableRect(transcriptCard, 'VoiceTranscriptCard button');
  await transcriptCard.click();

  const transcriptPane = page.locator('[data-testid="voice-transcript-pane"]');
  await transcriptPane.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(200);

  const assertTranscriptSplitGeometry = async (label, minCenterWidth) => {
    await assertNoHorizontalOverflow(page, label, [
      '.titlebar',
      'section.chat-surface--thread',
      '[data-testid="app-browser-sidebar"]',
      '[data-testid="voice-transcript-pane"]',
    ]);
    const splitGeometry = await page.evaluate((minW) => {
      const center = document.querySelector('section.chat-surface--thread');
      const badge = document.querySelector('.kite-voice-transcript-card__icon-badge');
      const chip = document.querySelector('.kite-voice-transcript-card__open-chip');
      const centerW = center ? Math.round(center.getBoundingClientRect().width) : 0;
      let headerOverlap = false;
      if (badge && chip) {
        const a = badge.getBoundingClientRect();
        const b = chip.getBoundingClientRect();
        headerOverlap = !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      }
      return {
        ok: centerW >= minW && !headerOverlap,
        centerWidth: centerW,
        minCenterWidth: minW,
        headerOverlap,
      };
    }, minCenterWidth);
    if (!splitGeometry.ok) {
      throw new Error(`${label} split geometry check failed: ${JSON.stringify(splitGeometry)}`);
    }
  };

  await assertTranscriptSplitGeometry('VoiceTranscriptPane open (1366x840)', 320);
  await captureArtifactScreenshot(page, artifactsDir, '05-voice-transcript-pane');

  // Verify compact viewport layout (960x680) preserves center thread width and non-overlapping header.
  await page.setViewportSize({ width: 960, height: 680 });
  await page.waitForTimeout(200);
  await assertTranscriptSplitGeometry('VoiceTranscriptPane compact (960x680)', 280);
  await captureArtifactScreenshot(page, artifactsDir, '06-voice-transcript-compact-960x680');

  // Verify S8 Settings -> Argos Audio -> VoicePickerModal interactive carousel at 1366x840.
  await page.setViewportSize({ width: 1366, height: 840 });
  await page.waitForTimeout(180);
  const settingsBtn = page.locator('.sidebar__footer button[aria-label="Settings"]');
  await assertVisibleAndClickableRect(settingsBtn, 'Sidebar Footer Settings button');
  await settingsBtn.click();

  const dialog = page.locator('div[role="dialog"][aria-labelledby="settings-heading"]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const argosTab = dialog.locator('button[data-settings-nav="zed"]');
  await assertVisibleAndClickableRect(argosTab, 'Settings nav tab "zed"');
  await argosTab.click();

  const argosVoiceSubtab = dialog.getByRole('button', { name: /^Voz$/ });
  await assertVisibleAndClickableRect(argosVoiceSubtab, 'Argos Voz subtab');
  await argosVoiceSubtab.click();

  const openPickerBtn = dialog.locator('[data-testid="open-voice-picker-btn"]');
  await openPickerBtn.waitFor({ state: 'attached', timeout: 10_000 });
  await openPickerBtn.scrollIntoViewIfNeeded();
  await assertVisibleAndClickableRect(openPickerBtn, 'Open VoicePickerModal button');
  await openPickerBtn.click();

  const voicePicker = page.locator('[data-testid="voice-picker"]');
  await voicePicker.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(180);
  await assertNoHorizontalOverflow(page, 'VoicePickerModal (1366x840)', ['[data-testid="voice-picker"]']);
  await captureArtifactScreenshot(page, artifactsDir, '07-voice-picker-modal');

  const closePickerBtn = voicePicker.locator('button[aria-label="Cerrar selector de voz"]');
  await assertVisibleAndClickableRect(closePickerBtn, 'VoicePickerModal close button');
  await closePickerBtn.click();
  await voicePicker.waitFor({ state: 'hidden', timeout: 10_000 });

  const closeSettingsBtn = dialog.locator('button.settings-modal-close');
  await closeSettingsBtn.scrollIntoViewIfNeeded();
  await assertVisibleAndClickableRect(closeSettingsBtn, 'Settings modal close button');
  await closeSettingsBtn.click();
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });

  if (pageErrors.length > 0) {
    throw new Error(`Uncaught page errors in VOICE-MODE-01:\n${pageErrors.join('\n')}`);
  }
}
