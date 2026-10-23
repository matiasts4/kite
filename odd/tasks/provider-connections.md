# Shared provider connections

Objective: persist every connected account as its own connection, with the auth method and the endpoints that connection actually unlocks, in one store that the installed app and the dev app both read.
Branch: not created. Do not commit on `main`. Working tree is already dirty in quota and operator files; implementation starts on a feature branch taken from that tree, without discarding those edits.
Delivery strategy: `ask-on-risk`. Forecast is well over 400 authored lines. Slices below are the review boundaries. Chain strategy is not chosen yet; do not open a pull request until it is.
Test runner: `npm test` (`vitest run`) for frontend; `cargo test` in `src-tauri` for Rust. Test-first when a deterministic test and a clear expected outcome exist: one RED test per requested rule, then GREEN, then refactor.

## Specs

Terms. Use these and no synonyms in code, tests, and docs.

- A driver is the integration kind (`opencode`, `antigravity`, `codex`, `claude`, `grok`, `gemini`, `cursor`). It is not an account and it is not a permission.
- A connection is one account plus one auth method. Two connections may share a driver.
- An auth method is how that account proved identity (`api_key`, `console_oauth`, `cli_session`, `local_rpc`, `google_oauth`, `acp`).
- An endpoint is one concrete route or CLI mode. Success on one endpoint does not verify another.
- Entitlement is what the subscription or key actually allows. It is not the same fact as "a binary was found".
- A capability shown in UI is the set of endpoints verified for that connection. Never derive it from the driver id alone.

S1. Provenance stays out of every artifact. Product documentation, changelog, UI copy, source comments, and commit messages describe this product's own implementation only: no external project names and no derivation or provenance claims. Do not open an upstream report about how this product was built.
Assumption: if a file already carries a third-party license header, keep it. That header is the license condition and is not a product-doc mention or an upstream report. Do not add a comment that names the origin and do not strip an existing license header.

S2. A connection does not unlock every endpoint of its driver. Be sharp. Do not store or display a single "connected" boolean for a driver. User words: "las suscripciones tienen sus limitantes" and "los endpoints, ¿no son los mismos para todos?" and "no son los mismos endpoints" and "No sirve para todo."
Interpreted requirement, marked as interpretation: the sentence "Toda conexión nos sirve para todo endpoint de ese proveedor" is contradicted by the sentences around it and by the OpenCode Go and Antigravity examples. Implement the surrounding meaning: a connection serves only the endpoints verified for that auth method. Do not implement a rule that one connection unlocks every endpoint of the driver.

S3. OpenCode Go is not valid for every OpenCode endpoint. User words: "OpenCode Go. Sirve de cierta forma, pero... no son los mismos endpoints para todo de OpenCode, así que... No sirve para todo."
Acceptance:
- A Go API key (`oc_sk_`) may be recorded against `GET https://opencode.ai/zen/go/v1/usage`, `GET https://opencode.ai/zen/go/v1/models`, and `POST https://opencode.ai/inference/go/openai/v1/chat/completions` only when `x-opencode-session` is sent.
- That same key must not be recorded or sent as valid for `https://opencode.ai/inference/v1/chat/completions` or `https://opencode.ai/inference/openai/v1/chat/completions`.
- A Console OAuth access token may be recorded against the Console status endpoint. It must not be used as the Go inference credential. `resolve_opencode_go_api_key` already returns only `ApiKey`; keep that split.
- Chat spawn `opencode run` with no model and no key is not evidence of a Go connection. Do not mark Go chat verified because the CLI started.
- Zed's current default base is already `https://opencode.ai/inference/go/openai/v1` (`src/lib/operator/operatorConfig.ts`). Do not "fix" it back to the pay-as-you-go base.
- Models whose ids start with `gpt-`, `grok-`, `claude-`, `gemini-`, or `muse-` are not Chat Completions models on the Go base. Do not offer them on that endpoint.

S4. Antigravity has more than one way in, and they do not unlock the same endpoints. User words: "para anti-gravity se tienen por API key, por la suscripción. Por la suscripción me refiero a cómo lo hace o lo hacemos nosotros por ACP. O también por Google OAuth".
Acceptance:
- Persist API key, ACP subscription, and Google OAuth as different auth methods on different connections when more than one exists. Do not collapse them into `provider = antigravity`.
- Quota via `agy` CLI, quota via local language-server RPC (`X-Codeium-Csrf-Token`), and chat via `agy -p` are different endpoints. RPC success must not mark the chat endpoint verified. CLI-not-signed-out is not RPC, and RPC is not ACP.
- `resolve_antigravity_acp_binary` has no callers today. Do not report an ACP connection as verified until an ACP session is actually established. The auth method may be stored as selected; `endpoints[].ok` stays false until a probe succeeds.
- Google account files (`~/.gemini/oauth_creds.json`, `google_accounts.json`) and Windows Credential Manager `gemini:antigravity` are identity. Kite does not send that Google token today. Do not mark inference endpoints verified from those files alone.
- Account snapshot/restore of CLI files is not itself an endpoint verification.

S5. Persist the full connection record, not a provider-name key. User words: "deberíamos poder guardar toda esa información de las cosas conectadas."
The record fields, derived from current code, are:
- `connection_id` (new; Kite has none)
- `driver_kind`
- `display_name`
- `auth_method` — one of `api_key`, `console_oauth`, `cli_session`, `local_rpc`, `google_oauth`, `acp`
- `account_identity` — email, `org_id`, and `account_id`, each optional. OpenCode Console needs `org_id`. Codex quota needs `ChatGPT-Account-Id`. Antigravity identity has an email.
- `credential_ref` — where the secret lives (`vault`, `env`, `cli_file`, `kite_file`). Do not copy the secret into a second plaintext store. localStorage is not a credential store.
- `endpoints` — list of `{ endpoint_id, ok, http_status, verified_at }`. Persist the verified list. Do not persist a driver-wide boolean.
- `entitlement` — `plan_type`, `billing_mode` (`subscription` or `payg`), `ok`. A 403 `EntitlementError` on Go means no Go subscription.
- `session_binding` — values an endpoint requires, such as `org_id` or that `x-opencode-session` is required. Not the secret.
- `status`, `last_checked_ms`, `expires_ms`, `last_http_status`
Uniqueness is `(driver_kind, auth_method, account_identity)`, not `driver_kind` alone. The current vault `provider TEXT PRIMARY KEY` (`src-tauri/src/credentials.rs`) cannot represent S3 or S4. Replace that key for connections. Do not drop unread secrets during the migration.
Same split already exists and must not be flattened for: Gemini (folder or `GEMINI_API_KEY` is not a chat endpoint; chat uses `gemini --prompt`), Codex (OAuth in `~/.codex/auth.json` is not `OPENAI_API_KEY`), Claude (OAuth usage is not `ANTHROPIC_API_KEY`), Grok (`~/.grok/auth.json` billing is not `GROK_API_KEY`; `grokUseCliSubscription` is only a boolean today), Kimi (OAuth file and API key hit different endpoints).

S6. The installed app and the dev app must keep sharing the same connection store. Connecting in one must make the other use the same account. User words: "Yo tengo una versión instalada y una versión de desarrollo. Sé que comparten y quiero que sigan compartiendo las mismas bases de conexiones, es decir, si yo conecto en la versión instalada, quiero que también se conecte la versión de desarrollo a la misma cuenta."
Current fact, not the desired state: they do not share Kite's own connection stores. `app_data_folder()` returns `Kite Code Dev` when `debug_assertions` and `Kite Code` otherwise (`src-tauri/src/persist.rs`). Each has its own `kite.sqlite` and `account-profiles\`. WebView2 user-data dirs differ (`dev.kite.code` vs `dev.kite.code.dev`), so localStorage is not shared. What already is shared, and must stay shared, is CLI auth under the user home (`~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.gemini/`, `~/.grok/auth.json`) and `~/.kite/opencode-go-quota.json`. `quota_cache.json` is accidentally shared because `src-tauri/src/quota/service.rs` hardcodes `Kite Code`.
Acceptance:
- The connection registry path must not branch on `cfg!(debug_assertions)`.
- Both apps read and write the same registry file.
- Canonical root, decision for this feature: `%APPDATA%\Kite Code\connections\` (sqlite plus the account-profile snapshots that belong to connections). Dev joins that folder. Do not invent a second root.
- Do not relocate threads, tickets, terminal sessions, or chat attachments in this feature. Those stay in the per-install app dir. Sharing connections is not sharing chats.
- First open of either app imports connection rows from both `%APPDATA%\Kite Code\kite.sqlite` `credentials_vault` and `%APPDATA%\Kite Code Dev\kite.sqlite` `credentials_vault`, and account profiles from both `account-profiles` trees, without deleting either source until the shared registry has those rows. Do not delete or rewrite CLI auth files during import. A rejected or partial import leaves those files byte-identical.
- localStorage may mirror a projection for the UI. It is not the source of truth. Native quota, Zed proxy, and chat must read the shared registry through IPC.
- Account switch still refuses while that driver is running. Switching still restores that driver's CLI files, which are already global. After the switch, both apps must show the same active connection because they read the same registry, not because each keeps its own `profiles.json`.

S7. A connection made in one surface is visible in the others only for endpoints that connection verified. Original request: "Si es que ya tiene un proveedor conectado. Que se pueda ver en la otra que ya está conectado." and the voice example was only an example: "Era un ejemplo, simplemente."
Acceptance: Quotas and Zed settings read the shared registry. A row appears in a surface only when that surface's endpoint is in `endpoints` and `ok` is true. Voice is not a driver. Voice may show a connection only when a voice endpoint for that connection is verified. Do not add a voice product in this feature.

S8. Zed must send prior turns, and chat must not drop the model on drivers that accept it. Original request: the agent surface is only slightly functional and "quizás ni siquiera guarda contexto."
Current fact: chat threads already persist in sqlite. Zed `planTurnLLM` sends only the system prompt and the current user message (`src/lib/operator/planner/llm.ts`). Chat passes `--model` for antigravity, claude, and codex only. Cursor, Grok, OpenCode, and Gemini spawns omit `--model` and omit session resume (`src-tauri/src/chat/runtime.rs`).
Acceptance for this feature's later slice, not the first commit:
- Zed's planner request includes bounded prior turns from the operator run, not only the current message.
- A chat or agent send passes `connection_id`, model, and session only to an endpoint that lists them as supported. OpenCode Go chat from the CLI is unsupported until a spawn exists that selects the Go model and session. Do not fake it by marking `opencode run` as that endpoint.
- Staged attachments are out of scope unless a path is already inserted in the prompt text. Do not silently start uploading attachment bytes.

S9. Context tools come after the connection record is honest. Original request mentioned Engram or MCPs as something to examine, not as the first cut. Do not wire Engram or a new MCP client into the send path in this feature. `AGENTS.md` append is not conversation memory and must not be presented as one.

## Tasks

- T1. Connection record types and uniqueness. S2, S5. Route: delegated after the user required subagents. Status: done. Evidence: `npm test -- src/lib/connections/types.test.ts` 2 passed; `cargo test connections::tests` 2 passed.
- T2. Shared registry path and import from both app-data vaults. S6. Route: delegated. Status: done. Evidence: `cargo test connections::` 6 passed, including path ignores dev flag and both vaults imported with source bytes unchanged. Risk: item 1 and item 2. Commit: none. The working tree already had unrelated edits, so this was not committed alone.
- T3. OpenCode Go vs Console vs CLI spawn as separate endpoint rows. S3, S5. Route: delegated. Status: done. Evidence: `cargo test quota::opencode::` 16 passed. CLI spawn marking is T6, not this task. Risk: item 2. Commit: none.
- T4. Antigravity API key, ACP, Google OAuth, CLI, and local RPC as separate endpoint rows. S4, S5. Route: delegated. Status: done. Evidence: `cargo test quota::antigravity::` 4 passed. The first worker was cancelled and left a compile break; the follow-up fixed the two call sites. Risk: item 2. Commit: none.
- T5. Quotas and Zed read the shared registry and filter by verified endpoint. S6, S7. Route: delegated. Status: done. Evidence: `npm test -- src/lib/operator/operatorProviders.test.ts` 21 passed; `cargo test connections::` 7 passed. Commit: none.
- T6. Chat and agent send uses `connection_id` and does not mark an endpoint verified when the spawn omits model or session. S3, S8. Route: delegated. Status: done. Evidence: `cargo test chat::runtime::` 8 passed; `cargo test chat_commands::` 2 passed. Risk: item 3. Commit: none. No UI picker writes `connectionId` yet.
- T7. Zed planner sends bounded prior turns. S8. Route: delegated. Status: done. Evidence: `npm test -- src/lib/operator/planner/llm.test.ts` 10 passed. No caller supplies history yet. Commit: none.
- T8. Sweep comments, changelog, and UI copy for forbidden origin mentions. S1. Route: parent at close. Status: done. Evidence: product code has no origin mention. The log below keeps the user's verbatim request. New settings copy was switched to the Spanish already used by those screens. Commit: none.
- T9. Pass prior operator-run turns into `planTurnLLM`. S8. Route: delegated. Status: done. Evidence: `npm test -- src/lib/operator/hooks/useOperatorTurn.test.ts` 13 passed. `executeTurn` passes `withPriorTurnHistory` unless the caller already set `history`. Commit: none.
- T10. A chat thread writes `connectionId` and `supportedEndpoint` only for a spawn endpoint that connection has verified. S8. Route: delegated. Status: done. Evidence: `npm test -- src/components/views/chat/connectionBinding.test.ts` 11 passed; `ChatComposer.test.tsx` 10 passed. A reload through the native thread store drops the two fields; one verified match is rebound from the registry, several matches ask again. Commit: none.
- T11. A provider-key save also writes the shared registry, with no endpoint marked ok. S5, S6. Route: delegated. Status: done. Evidence: `cargo test connections::` 14 passed, including re-save keeps a verified endpoint. Independent verifier: no blockers. Risk: item 1 and item 2. Commit: none. Non-driver keys stay vault-only.

Slice A is T1–T5. Slice B is T6–T7. S9 is not a task.

## Invariants for every task

- Reuse `credentials::` vault encryption for secrets. Do not write a second cipher.
- Do not key the new table by driver name alone.
- Do not branch the registry path on `debug_assertions`.
- Do not delete `~/.codex`, `~/.claude`, `~/.gemini`, `~/.grok`, or `~/.kite` contents as part of import.
- A failed import leaves source sqlite files and CLI auth files unchanged. Tests that reject a command must assert those bytes are unchanged.
- Do not add requirements that are not in Specs. Assumptions stay marked as assumptions.
- Generated artifacts stay in English. Do not put Rioplatense slang in identifiers, UI copy, or comments.
- Do not name an external project in comments, docs, changelog, or commit messages.

## Verification

- T1: one Rust or TS test that two auth methods for `opencode` produce two connection ids, and a second test that a Go key cannot be stored with the pay-as-you-go chat endpoint id marked `ok`.
- T2: test the path helper returns a path ending in `Kite Code\connections` even when the caller passes a dev flag. Test import reads two fixture sqlite files from a temp dir outside the repo and does not modify a fixture CLI auth file (hash unchanged).
- T3: test Console OAuth is rejected by the Go inference resolver. Test `opencode run` with no model does not set the Go chat endpoint `ok`.
- T4: test RPC-only status does not set the `agy` chat endpoint `ok`. Test selecting ACP without a successful session leaves `ok` false.
- T5: test a connection with only a quota endpoint is listed in quotas and absent from the Zed chat provider list.
- T6: test cursor, grok, opencode, and gemini spawn args still omit `--model` until an explicit supported-endpoint flag is set, and that setting the flag without a supported endpoint is a test failure, not a silent add.
- T7: test `planTurnLLM` message list contains the previous user turn when one is supplied, and still contains only system plus current user when history is empty.
- Focused test, then the suite, once each, per slice. Do not invent a runner.

## Allowed edit surfaces

Exact surfaces are fixed per task at delegation time. Anticipated, not a blank check:

- T1: `src-tauri/src/connections.rs` (new), `src/lib/connections/types.ts` (new), `src/lib/connections/types.test.ts` (new)
- T2: `src-tauri/src/connections.rs`, `src-tauri/src/persist.rs`, `src-tauri/src/credentials.rs`, `src-tauri/src/account_switcher.rs`, `src-tauri/src/main.rs`
- T3: `src-tauri/src/quota/opencode.rs`, `src/lib/operator/operatorConfig.ts`, `src-tauri/src/operator_runtime.rs`
- T4: `src-tauri/src/quota/antigravity.rs`, `src-tauri/src/acp.rs`, `src-tauri/src/account_switcher.rs`
- T5: `src/lib/quota/quotaManager.ts`, `src/components/views/settings/QuotasTab.tsx`, `src/components/views/settings/zed/ZedProvidersSection.tsx`, `src/lib/operator/operatorProviders.ts`
- T6: `src-tauri/src/chat/runtime.rs`, `src-tauri/src/chat_commands.rs`, `src/components/views/chat/useChatSession.ts`
- T7: `src/lib/operator/planner/llm.ts`, `src/lib/operator/index.ts`

Do not edit the external reference checkout. Do not edit WebView2 caches.

## Log

L1. 2026-10-22. Product intent, restated without external references: The provider story is fragmented across surfaces, so connections, models, quotas, and accounts must be organized behind one coherent configuration that every surface reads from. The agent and chat work comes next. Context tools may be examined, but only after the provider layer is honest.

L2. 2026-10-22. User confirmed Seth is the Zed operator. Voice was an example of cross-surface visibility, not a request to build voice. "codecs" in the original request is read as Codex unless the user corrects it.

L3. 2026-10-22. User correction, verbatim:

¿O que estás confundiendo dos cosas? Una. Sí podemos copiar. Ahora no es necesario que lo digamos. A eso me refiero. Que la documentación no se menciona. Tampoco quiero reportarles que copiamos, o sea, no es el caso. A ver, claro, también hay que tener consideraciones. Eh, ¿las suscripciones tienen sus limitantes? Es decir, los send points, ¿no son los mismos para todos? Entonces, hay que ser tajantes con eso y... no confundir términos ni nada. En caso de que no haya que modificar... continuamos, pero si es que hay que modificar... ajusta un poco el plan. Claro está. Por ejemplo, me refiero a cosas como que... Eh... OpenCode Go. Sirve de cierta forma, pero... No lo mis, no son los mismos endpoints para todo de OpenCode, así que... No sirve para todo. En ese ámbito, o sea. Toda conexión nos sirve para todo endpoint de ese proveedor, a eso me refiero. Entonces, por ejemplo, para anti-gravity se tienen por API key, por la suscripción. Por la suscripción me refiero a cómo lo hace o lo hacemos nosotros por ACP. O también por Google o Auth, si no estoy mal. Y bueno, ese tipo de cosas. Y la idea es que revises un poco. Y... claro, deberíamos poder guardar toda esa información. de las cosas conectadas. Y otro punto importante. Yo tengo una versión instalada y una versión de desarrollo. Sé que comparten y quiero que sigan compartiendo. las mismas bases de conexiones, es decir, si yo conecto en la versión instalada , quiero que también se conecte la versión de desarrollo a la misma cuenta. Ese tipo de cosas. Entonces, ve con las modificaciones en caso de que hayan que hacer. Recuerda que tienes subagentes para delegar estas tareas, pero el ODD tiene que estar perfectamente armado para que cumplan su rol. A la perfección claramente, entonces continúa.

L4. 2026-10-22. Evidence used to rewrite S2–S6. Dev identifier `dev.kite.code.dev` and folder `Kite Code Dev` are separate from installed `dev.kite.code` and `Kite Code`. Vault primary key is `provider`. Zed OpenCode base is already the Go chat URL. Antigravity ACP resolver has no callers. Decision: shared root `%APPDATA%\Kite Code\connections\`, connections only, not threads. Next: T1, no source write before this document is the spec a worker reads.

L5. 2026-10-22. User said continue, then required coding to be delegated. T1–T7 were implemented by workers. Parent spot-checks: connections 6 passed, opencode 16 passed, antigravity 4 passed, operatorProviders 21 passed, chat runtime 8 passed, llm planner 10 passed. Not committed: the branch already carried unrelated dirty files, and a mixed commit would label that older work as this feature. Open gap: no UI writes `connectionId` or Zed `history` yet, so the new contracts are unused until a picker and a turn buffer exist.

L6. 2026-10-23. User, verbatim: "continua entonces con lo faltante, usa subagentes para delegar". Parent split the three in-plan gaps into T9, T10, and T11. Engram, MCP, voice, attachments, and the other driver splits stay out. Do not commit the mixed tree.

L7. 2026-10-23. T9–T11 implemented by workers. Parent spot-check: operator hook 13 passed, connection binding 11 passed, connections 14 passed. A first T11 write erased probe endpoints on re-save; the follow-up keeps them and still drops the two pay-as-you-go OpenCode chat routes on a subscription Go key. Verifier blockers: none. Not committed.
