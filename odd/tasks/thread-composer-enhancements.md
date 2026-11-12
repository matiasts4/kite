# Thread Composer Enhancements: Selectors Motion, Grok Models, Reasoning Detection & Notification Refinements

Status: overlapping menu motion, Grok catalog, and effort collapsing are owned by `odd/tasks/thread-provider-runtime.md` and `odd/tasks/thread-composer-and-navigation.md`. The confirmed menu motion is 80ms, a 4px drift, `cubic-bezier(0.32, 0.72, 0, 1)`, and no scale. Do not implement the 0.13s scale motion in S1 of this file.

Objective: upgrade the Thread chat surface with snappy directional popover animations, fix Grok model discovery and interaction, automatically detect and collapse multi-tier thinking models into the discrete effort slider, and eliminate inaccurate cancellation toasts and notification spam.
Branch: `feat/ui-composer`. Do not commit on `main`.
Delivery strategy: `ask-on-risk`.
Test runner: `npm test` (`vitest run`) and `cargo test`.

## Specs

### S1. Snappy directional popover animations for composer selectors
User words: "Actualmente no me gusta mucho la animación de cuando se despliega cada uno de los selectores, por ejemplo del modelo, del nivel de pensamiento, del tipo de plan y de permisos... se siente un poco lento o raro... más rápido y de abajo hacia arriba."
Current fact:
- Popovers use `.kite-floating-card` with an unanchored center-scaling fade (`kiteFadeIn 0.12s ease-out; transform: scale(0.97)`).
- `getAnchoredPopoverCoords` returns `origin: 'bottom' | 'top'`, but the rendered popover panels do not receive or bind `data-origin`.
Acceptance:
- All composer popovers (`ModelPickerPopover`, `EffortSliderPopover`, `WorkModePickerPopover`, `PermissionPickerPopover`, `AttachMenuPopover`, `ConnectionPickerPopover`) bind `data-origin={coords.origin}` to the floating container.
- When anchored above the composer controls (`origin="bottom"`), popovers animate cleanly upwards (`translateY(6px) scale(0.98)` to `translateY(0) scale(1)`) with `transform-origin: bottom center`.
- Snappy easing (`0.13s cubic-bezier(0.16, 1, 0.3, 1)`) with no perceptible visual lag or floatiness.

### S2. Grok model discovery, driver declaration, and interactive trigger
User words: "Relacionadas con Grok: actualmente no me aparecen los modelos para seleccionar... sino que me aparece Automatic. Y bueno, la aprieto y no pasa nada. Cosa que está rara, no se están obteniendo correctamente los modelos."
Current fact:
- `src-tauri/src/chat/drivers.rs` hardcodes `accepts_model: false` and `accepts_effort: false` for Grok, declaring "no model flag was observed".
- `src-tauri/src/chat/models.rs` `fetch_grok_models_dynamic` runs `grok models`. On CLI 1.0.70+, the output prints `Default model: grok-4.6 (not in the list below)` followed by an empty bullet list. `parse_grok_models` only matches `* ` / `- `, returning `[]`.
- `ModelPickerPopover.tsx` triggers `disabled={disabled || models.length === 0}` which renders the button inactive when 0 models are returned, preventing clicking.
Acceptance:
- `src-tauri/src/chat/drivers.rs` declares `accepts_model: true` and `accepts_effort: true` for Grok, with `--model` and `--reasoning-effort` support.
- `src-tauri/src/chat/models.rs` parses `Default model: <id>` and provides a baseline dynamic catalog for Grok (`grok-4.6`, `grok-4`, etc. with reasoning effort flags) if the CLI catalog is empty.
- `ModelPickerPopover.tsx` allows opening the selector even if the catalog is loading or has 0 initial items, displaying appropriate status rather than deadening the click.

### S3. Multi-tier reasoning / thinking level detection and model collapsing
User words: "Diferentes proveedores tienen diferentes modelos con diferentes niveles de pensamiento... deberíamos poder detectar los niveles de pensamiento (low, medium, high, extra high, max...) y en lugar de que aparezcan cinco veces un solo modelo... detectarlos y utilizar nuestro componente de nivel de pensamiento."
Current fact:
- Providers list multiple separate model entries for reasoning variants (e.g. `model-low`, `model-medium`, `model-high`, `model-xhigh`, `model-max`, `model-minimal`).
- The model picker gets cluttered with duplicate names, and the reasoning slider remains inactive or desynchronized.
Acceptance:
- Intelligent model collapsing: detects reasoning suffixes (`-low`, `-medium`, `-high`, `-xhigh`, `-max`, `-minimal`, `:low`, `:medium`, ` (High)`, etc.).
- Groups variants into a single clean base model entry with `supportsEffort: true` and populated `effortLevels`.
- Automatically maps the chosen effort level when preparing execution arguments: passes `--effort` / `--reasoning-effort` if supported by the driver, or resolves to the variant model ID if the CLI expects the suffixed identifier.

### S4. Refined notification & audio cue policy on cancellation & turns
User words: "Si yo cancelo un chat y me llega la notificación de que se terminó o que se ejecutó correctamente la conversación... me llega al cancelar... no debería aparecer una notificación toast cada vez que responde en threads. Lo que sí podría hacer es un ligero tono de sonido cuando termine."
Current fact:
- In `src-tauri/src/chat/runtime.rs`, stopping a turn sets `outcome: "cancelled"`.
- `useNotifications.ts` checks `rec.kind.outcome !== 'failed'`, which evaluates to `true` for `"cancelled"`, playing the victory chime and calling `toast.agentSettled`.
- `toast.agentSettled` in `src/lib/toast.ts` treats any non-failed outcome as `sileo.success("Completed")`, so cancelling a chat spawns a "Completed" toast.
- Thread responses trigger toast popups on every completed turn, creating screen clutter during active conversation.
Acceptance:
- When a turn is cancelled (`outcome === 'cancelled'` or `stoppedByBuilder`), no completion chime or success toast is produced.
- Active thread completions rely on the subtle audio chime (`playCompletionChime`) without spamming ambient toast banners for each turn.

## Tasks

- T1. Directional popover animations (`data-origin`, `kitePopUp`, `kitePopDown`, 130ms snappy spring curve). S1.
- T2. Grok driver declaration, CLI model parsing, and fallback catalog. S2. Status: implemented. The live catalog is `~/.grok/models_cache.json`; `grok models` on 1.0.77 prints a default that is not in the list and no bullets. The picker stays clickable while that list is empty.
- T3. Reasoning effort detector & variant model collapser in model discovery and execution bridge. S3.
- T4. Cancellation notification suppression & thread toast refinement. S4.

## Verification

- `npx vitest run src/components/views/chat`
- `npx vitest run src/lib/notifications`
- `cargo test chat::`
- `npx tsc --noEmit`
- `node .kite/sanitizer/audit-references.mjs --check`
