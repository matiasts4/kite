# Per-Model Quota Exhaustion Alerts & Visual Indicators

Objective: Notify users proactively and at runtime when any specific model or model-family quota window reaches `0%` (even when the provider's primary quota pill remains above `0%`), and display per-model exhaustion/low-quota indicators inside the model picker, composer trigger, header quota badge, toasts, and notification center.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `single-pr` on `feat/response-thread` (isolated commit touching only quota alerts/UI files; pre-existing concurrent diffs untouched).
Test runner: `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code quota`, `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code notifications`, `npx vitest run src/lib/quota src/components/quota src/components/views/chat`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.

---

## Specs

### S1 — Shared Model-to-Quota-Window Resolution
Addresses cases where one provider exposes multiple quota pools (for example `Antigravity` exposing `Gemini Models (Five Hour)` at `38–73%` alongside `Gemini 4 Argon (Gemini 4 Argon Weekly Limit)` at `0%` or `Claude and GPT models`).

1. **Deterministic Frontend Matcher (`src/lib/quota/modelQuota.ts`):**
   - Canonicalize provider IDs (`"agy"` -> `"antigravity"`, `"claude-code"` -> `"claude"`).
   - Strip trailing effort tiers (`-high`, `-medium`, `-low`, `-xhigh`, `-max`, `-minimal`, `-ultra`, `-fast`) when matching `modelId` + optional `modelLabel` against `ProviderQuotaStatus.windows`:
     - **Specific bucket pass:** Match dedicated model/codename buckets first (for example `"Gemini 4 Argon (...)"` matches `"gemini-4-argon"` strictly and never steals `"gemini-4-hydrogen"`, `"gemini-2.5-flash"`, or `"gemini-3.1-pro"`).
     - **Family pool pass:** Match `"claude"`/`"gpt"`/`"o1"`/`"o3"`/`"o4"` models to `"Claude and GPT models"` pools, and remaining `"gemini"` models to non-variant `"Gemini Models"` pools, picking the most constrained window (`isExhausted` first, then lowest `remainingFraction`).
     - **Provider-wide fallback pass:** For single-pool providers, select the most constrained window.
   - Provide `isWindowExhausted`, `isWindowLow` (`> 0 && <= 10%`), `getWindowRemainingPercent`, and `collectExhaustedModelWindows`.

---

### S2 — Proactive & Runtime Model-Quota Exhaustion Alerts
Addresses *"que me avise si cuando se acabe la cuota de ese modelo. Claramente ahora mismo no me está avisando"*.

1. **Backend Window Transition Detection & Event Emission (`src-tauri/src/quota/service.rs`, `src-tauri/src/notifications.rs`):**
   - Emit `"kite://subscription-quotas-updated"` after **forced** refreshes (`is_force == true`) in addition to background SWR refreshes so `subscriptionQuotaManager` stays synchronized after manual or post-error refreshes.
   - Track exhausted `(provider_id, window_name, resets_at)` tuples in `collect_new_exhausted_alerts` so fresh fetches emit **`"kite://model-quota-exhausted"`** once per reset cycle without spamming every 90-second poll, and re-arm automatically when the window recovers (`> 0%`) or `resets_at` changes.
   - Record an unread notification (`upsert_model_quota_exhausted_notification`, `kind: { "kind": "modelQuotaExhausted", "requestKind": provider_id }`, `target: { "source": "accountVault", "id": provider_id }`) in `notifications.rs` with dedup key so missed toasts remain visible in the notification bell.
2. **Runtime UsageLimit Refresh & Actionable Toast (`ThreadErrorBanner.tsx`, `useAppGlobalEvents.ts`, `NotificationsView.tsx`):**
   - When `ThreadErrorBanner` observes `failure.kind === 'usageLimit'`, dispatch `kite:usage-limit-detected` so `useAppGlobalEvents` triggers an immediate forced quota refresh (`subscriptionQuotaManager.fetchAll(true, ...)`) and shows a deduplicated `toast.action` warning with `"Ver cuotas"` navigation.
   - Subscribe in `useAppGlobalEvents.ts` to both `"kite://model-quota-exhausted"` and `subscriptionQuotaManager` transitions (deduplicated per `(providerId, windowName, resetsAt)`).
   - Render `kind.kind === 'modelQuotaExhausted'` cleanly in `NotificationsView.tsx` with alert styling and click-through to `openSettingsTab('quotas', rec.target.id)`.

---

### S3 — Model Picker, Composer & Header Quota Warning Indicators
Complies strictly with `AGENTS.md` token rules (`--vl-radius-xs`, `--control-radius`, `--card-radius`, zero changes to `TitleBar.tsx`).

1. **`ModelPickerPopover.tsx` & `composer.css`:**
   - Subscribe to `subscriptionQuotaManager` and resolve the quota window for the selected trigger model as well as each row in the picker list (including cross-provider Favorites).
   - Mark exhausted (`0%`) models with `0%` danger badge and low (`1–10%`) models with percentage warning badge (`border-radius: var(--vl-radius-xs)`), and show a compact `0%` / `≤10%` warning indicator on the composer trigger when the active model is affected.
2. **`SubscriptionQuotaBadge.tsx`:**
   - When `displayProvider` has `remPct > 0` (for example `73%`) yet one or more windows are exhausted (`isExhausted || remainingFraction <= 0`), display a subtle `rounded-full` warning dot inside the header badge and include the exhausted window name(s) in `title` / `aria-label`.

---

## Tasks

- [x] **T1** (`S1`, Risk: `none`, route: `inline`, ~160 lines): Create `src/lib/quota/modelQuota.ts` with deterministic window matching & helpers plus comprehensive Vitest unit tests (`src/lib/quota/modelQuota.test.ts`).
- [x] **T2** (`S2`, Risk: `item 3, item 4 — quota cache/event & notification persistence`, route: `inline`, ~220 lines): Add `collect_new_exhausted_alerts` + forced-refresh event emission in `src-tauri/src/quota/service.rs`, `upsert_model_quota_exhausted_notification` in `src-tauri/src/notifications.rs`, Rust unit tests, `ThreadErrorBanner` event dispatch, `useAppGlobalEvents` alert handler, and `NotificationsView` support.
- [x] **T3** (`S3`, Risk: `item 3 — model picker & header quota UI`, route: `inline`, ~200 lines): Wire per-model quota indicators into `ModelPickerPopover.tsx` / `composer.css` and sub-window exhaustion indicator into `SubscriptionQuotaBadge.tsx`, add Vitest component tests, and verify full Rust/TS/Vitest/sanitizer checks.

---

## Log

- **L1 (2026-11-16 — User Feature Request & Evidence):**
  > "También sería bueno agregar, eh, algo bastante importante. Que tiene que ver con que me avise si cuando se acabe la cuota de ese modelo. Claramente ahora mismo no me está avisando. Eh, pero es importante."
  - Observed live `quota_cache.json`: `antigravity.primaryRemainingPercent` stayed at `73%` (then `38%`) while `"Gemini 4 Argon (Gemini 4 Argon Weekly Limit)"` hit `0%` (`isExhausted: true`, later `1%`), leaving no warning in header badge, model picker, toast, or notifications.
- **L2 (2026-11-16 — Verification & Completion):**
  - Observed RED tests first, implemented `S1`–`S3`, and verified `npx tsc --noEmit` (clean), targeted Vitest suite (`52 files / 357 tests passed`), `notifications::tests` (`4/4`), `quota::service::tests` (`2/2`), and `audit-references.mjs --check` (`[AUDIT CLEAN]`).
