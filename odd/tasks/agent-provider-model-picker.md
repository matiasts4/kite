# Agent provider and model picker

Objective: in the Agent chat surface, the provider and model chosen before the first message must survive thread creation, changing provider must not leave the previous provider's model selected, and dynamic models must load automatically and stay in memory for the session.
Branch: `feat/provider-connections`. Do not commit on `main`.
Delivery strategy: `ask-on-risk`. This slice is UI-only and under 400 authored lines.
Test runner: `npm test` (`vitest run`). Test-first: one RED test per rule, then GREEN.

## Specs

S1. The Agent draft must honor the selected provider. User words: "intento seleccionar el proveedor. No me deja seleccionar ningún otro que no sea Anti-Gravity."
Current fact: with no active thread, `ChatView` gates `onUpdateConfig` behind `activeThreadId && ...`, so the change is dropped. `onSendInitial` and `handleCreateNewThread` create the thread with `session.defaultProvider`, which is the agent engine. The agent engine in the report is Antigravity.
Acceptance:
- Changing provider or model before the first send updates a draft config, not a no-op.
- The first thread is created with the draft provider, mode, and model. It does not fall back to the agent engine when the user chose another provider.
- The same draft config survives `handleCreateNewThread` and split creation.
- With an existing thread, changing provider or model still persists through the existing commands.

S2. Changing provider must reset the model. User words: "selecciono modelo. No me deja seleccionar ninguno que no sea anti-gravity claramente."
Current fact: `handleUpdateConfig` keeps `thread.model` when `patch.model` is absent, so a new provider inherits the previous provider's model id.
Acceptance:
- When the provider changes and the patch does not name a model, the model becomes `null` (Automatic) and the composer shows the new provider's default.
- A model id from another provider is never sent as the new provider's selection.
- Same-provider model changes and explicit model patches are preserved.
- The connection binding rule from T10 still clears on provider change.

S3. Dynamic models load without a manual refresh and stay in memory for the session. User words: "No me gusta que, siempre tenga que haber un botón grande. Que diga refresh models. Estaría bastante bueno que se consultaran los modelos. Antes que yo la apretara. Para no tener que estar retardando siempre. Y bueno, que se almacenen. En memoria. Los modelos."
Current fact: `ChatComposer` adds a `Refresh available models…` row to the model menu. `useChatModels` fetches only the initial provider and the provider the user changes to. The native `provider_models` already caches for 15 minutes.
Acceptance:
- The model menu no longer shows a refresh row or a refresh action.
- Dynamic providers are prefetched once when the chat session mounts, without blocking the UI.
- A provider's models are requested at most once per mounted session unless a caller explicitly forces a refresh. The fetched list stays in the in-memory `dynamicModelsMap`.
- If a fetch fails or is empty, the static `PROVIDER_CATALOG` list remains usable.
- No new localStorage key and no new persisted cache.

## Tasks

- T1. Agent draft provider, mode, and model; reset model on provider change. S1, S2. Route: delegated. Status: done. Evidence: `npm test -- src/components/views/chat/hooks/useChatDraftConfig.test.ts` 10 passed; `npm test -- src/components/views/chat` 37 passed; `cargo test chat_commands::` 6 passed. The draft inherits the agent's `defaultModel` when configured. `create_agent_chat` now honors the request provider over the agent engine.
- T2. Automatic dynamic-model prefetch and remove the manual refresh row. S3. Route: delegated. Status: done. Evidence: `npm test -- src/components/views/chat/hooks/useChatModels.test.ts src/components/views/chat/ChatComposer.test.tsx` 16 passed. Models prefetch once per mounted session per dynamic provider; the manual refresh row is gone.

## Invariants

- English identifiers and comments. UI copy follows the component's existing language.
- Do not edit Rust. Do not edit the provider connection registry or its binding rules.
- Do not treat a provider id as permission to send a model the provider does not accept.
- Do not add a second model cache outside React state and the existing native cache.
- Preserve unrelated dirty changes in every touched file.

## Verification

- T1: a pure draft-config test proves provider change resets the model, and the thread request uses the draft provider and model instead of the agent engine default.
- T2: a test proves the refresh row is absent and a provider's models are requested once per session while a failed fetch keeps the static catalog.
- Focused test, then the touched suite, once each. Do not invent a runner.

## Log

L1. 2026-10-23. User request, verbatim:

"Quiero que corrijas una parte que funciona tanto mal. En agent, y bueno. respectivamente. En. Bueno, en agent funciona de una parte mal. Básicamente intento seleccionar el proveedor. No me deja seleccionar ningún otro que no sea Anti-Gravity. Luego le doy en, selecciono modelo. No me deja seleccionar ninguno que no sea anti-gravity claramente. Y también hay un problema bastante grande que, me molesta mucho con respecto a, los modelos que aparecen por cada proveedor. No me gusta que, siempre tenga que haber un. Botón grande. Que diga refresh models. Estaría bastante bueno que se consultaran los modelos. Antes que yo la apretara. Para no tener que estar. Retardando siempre. Y bueno, que se almacenen. En memoria. Los modelos."

L2. 2026-10-23. Evidence: `ChatView.tsx` computes `activeThread?.provider || session.defaultProvider` and calls `onUpdateConfig` only when `activeThreadId` is set. `useChatSession.handleStartThreadFromHome` and `handleCreateNewThread` pass `defaultProvider` from the agent engine. `handleUpdateConfig` keeps `thread.model` when the patch has no model. `ChatComposer` renders a `__refresh_models__` row. `useChatModels` only fetches the initial provider and on provider change. The native `provider_models` cache has a 15-minute TTL.

L3. 2026-10-23. T1 and T2 implemented by workers. A third worker fixed the real backend blocker: `create_agent_chat` ignored the request provider and always used the agent engine. Parent spot-checks: chat suite 37 passed, `chat_commands::` 6 passed, `npx tsc --noEmit` exit 0. Known limit: an existing empty draft loaded from `handleCreateNewThread` is not rewritten with the current draft, so the user must change provider on that thread. Not committed.
