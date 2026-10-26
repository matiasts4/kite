# Animate UI preview lab

Objective: install the `animate-ui` skill globally and add a dev-only preview surface that applies Animate UI motion tokens to Kite's component patterns, so the team can judge the look before any rollout.
Branch: `feat/agent-sessions` (working tree already has unrelated changes; this feature stays uncommitted unless requested).
Delivery: one preview surface behind `?animate`, dev-only; no production route changes.
Checks: `npx tsc --noEmit`, `npx vite build --outDir <temp>` (production bundle must not include Motion code), browser screenshot of `?animate`.

## Specs

S1. The `animate-ui` skill is installed for every agent and complete: `SKILL.md`, `references/**` (including `recipes/` and `interactions/`), and `scripts/` exist under the global skill root. The Claude junction points at the same copy. No project-level install is added.
S2. `?animate` renders the preview page only in Vite dev. A production build keeps routing to `App` and does not ship Motion code.
S3. The preview imports `motion` and uses Animate UI's tokens: the spring values from `tokens.md`, the tween curves, `scale.*`, `blur.*`, `shift.*`, and the reduced-motion behavior. No hand-typed spring for a role a token covers.
S4. The page exposes three intensity levels (`subtle`, `more`, `expressive`), a tempo control (`0.6`–`1.6`), and a reduced-motion toggle. Level and tempo affect only the Animate UI column; reduced motion affects both columns. Every demo follows all applicable controls without per-demo overrides.
S5. The preview compares four complete components side by side, driven by one shared state per scene: a chat pane (transcript + composer + quota popover), a settings card (tabs + switch + disclosure + save), a workspace (thread rail + context menu + editor + right dock), and a usage/notifications surface (modal + toast stack). Each column renders the same component and state; only the motion engine differs.
S6. `?motion` links to `?animate` and the preview links back, so both labs are discoverable from the running app.
S7. The page is self-contained under `src/motion/animate/` and does not modify product components or their styles.
S8. A single shared state drives both columns in every scene, so an action taken in either column animates the same change in both.
S9. The lab is split into nine numbered pages (01–09) with a persistent page nav and a URL parameter (`?animate=<n>`), so each page is linkable and no page is a dead end.
S10. Every page uses the shared frame (`CompareScene`, `SceneButton`, `SceneSwitch`), shared motion tokens and shared Kite CSS motion helpers. Each page owns its own folder and CSS; no page edits another page, the shell, the shared frame, or production files.
S11. The full expansion map is covered: controls and inputs; navigation and layout; feedback and state; data and content; overlays; complete Kite scenes A (chat, settings, workspace, tasks); complete Kite scenes B (notifications, agents, onboarding, primitives); gestures and structural motion; and the motion-system reference (tokens, level/tempo, reduced motion, keyboard parity, interruption, performance).
S12. The chat scene shows the motion language at the transcript's lowest level: streaming assistant text reveals per token with a caret, tool rows show a live running state and a done transition with reflow, and appearing components (approval, error/retry, attachments, model popover) enter and change state with the standard springs. Only the Animate UI column gets these; Kite keeps its current behavior.
S13. The button and card scenes carry a distinct personality in the Animate UI column: hover lift/glow, press depth, success/error morphs, a magnetic or hold-to-confirm control, spotlight/tilt cards and an agent/profile card. Kite remains the baseline for comparison.
S14. Page 10 is the visual-language surface: it compares the current Kite values against a proposed scale of radius, stroke, surface, control height and focus; it shows checkbox/radio/switch, fields, buttons and cards/overlays with the proposed geometry. The proposed column is a design proposal, not a production change, and the level/tempo controls are disabled there because the page is about shape and surface.

## Expansion pages

| Page | Folder | Scope |
| --- | --- | --- |
| 01 Controles | `src/motion/animate/pages/controls/` | Buttons, icon buttons, animated icons, checkbox, radio, switch, toggle group, slider, input/textarea, validation, select/combobox, search, keyboard/interruption |
| 02 Navegación | `src/motion/animate/pages/navigation/` | Tabs, sidebar collapse/tree/reorder, menus, command palette, accordion, pagination, tooltip, dock/resizable panels |
| 03 Feedback | `src/motion/animate/pages/feedback/` | Toasts, banners/validation, progress, skeleton, spinner, badges/status, empty/error, save status |
| 04 Datos | `src/motion/animate/pages/data/` | Lists, tables, cards/shared element, numbers, text effects, diff, terminal, transcript |
| 05 Overlays | `src/motion/animate/pages/overlays/` | Dialog/alert, sheet/drawer, popover/menu/tooltip/hover card, command palette, notification center, quota/file picker |
| 06 Escenas A | `src/motion/animate/pages/scenes-a/` + `src/motion/animate/scenes.tsx` | Chat, settings, workspace, tasks/kanban (extends the existing scenes) |
| 07 Escenas B | `src/motion/animate/pages/scenes-b/` | Notifications/usage, agents gallery, onboarding/intro, primitives playground (imports the existing notifications scene) |
| 08 Gestos | `src/motion/animate/pages/gestures/` | Shared element, reorder, drag & drop, scroll reveal/progress/live edge, page/view transitions, stagger, interruption |
| 09 Sistema | `src/motion/animate/pages/system/` | Token reference, level/tempo matrix, reduced motion, keyboard/pointer parity, interruption stress, performance checklist |
| 10 Lenguaje | `src/motion/animate/pages/visual/` | Visual language: radius/stroke/surface tokens, checkbox/radio/switch, fields, buttons, cards and overlay surfaces, Actual vs Propuesto |

## Tasks

- T1 — Add `motion` as a dev dependency and port the Animate UI tokens plus level/tempo derivation. (S3, S4) — done; `tokens.test.ts` 5/5.
- T2 — Build the page shell, top controls, numbered page navigation, URL state, and the shared comparison frame. (S2, S4, S9, S10) — done; 9 nav items, `?animate=<n>` syncs, production build excludes the lab.
- T3 — Build page 01 controls. (S11) — in progress.
- T4 — Build page 02 navigation. (S11) — done.
- T5 — Build page 03 feedback. (S11) — done.
- T6 — Build page 04 data. (S11) — done.
- T7 — Build page 05 overlays. (S11) — done.
- T8 — Build page 06 scenes A. (S11) — done; `AlertsScene` preserved for page 07.
- T9 — Build page 07 scenes B. (S11) — done.
- T10 — Build page 08 gestures. (S11) — done.
- T11 — Build page 09 system. (S11) — done.
- T12 — Integrate pages, run typecheck/build, browser QA each page, and fix integration defects. (S9, S10, S11) — in progress.
- T13 — Elevate the chat scene: token streaming, live tool rows, approval/error/attachment/model transitions. (S12) — done; streaming words + caret, live tool pills with detail/duration/check, approval stamp, error shake/retry, attachment stagger and model/quota motion.
- T14 — Add button personality: hover lift/glow, success/error morphs, magnetic or hold-to-confirm. (S13) — done; primary lift/glow/sheen, press depth, save glyph morph, destructive shake, pin ring, gliding group indicator and magnetic follow.
- T15 — Add card personality: spotlight/tilt card, agent/profile card, premium hover/shared-element detail. (S13) — done; cover zoom, hover lift/shadow, spotlight tilt, agent card with pulse/actions and staggered detail.
- T16 — Build page 10 visual language: tokens, selection controls, fields, buttons, cards/surfaces, Actual vs Propuesto. (S14) — done; 5 scenes, 10 panes, 5 checks, 3 radios, 2 switches, 4 fields, 22 buttons and 4 cards verified in the browser lane.

## Log

L1 — User request (verbatim): "https://github.com/imskyleen/animate-ui npx skills add imskyleen/animate-ui Mira, recientemente, o, ah, bueno, hace unos días. Incluimos algunas políticas para mejorar lo que son las animaciones. Transiciones de. Varios componentes. Lo que está bastante bien, pero. Me encontré con este repositorio. Que es de. Eh, código abierto al parecer. Me gustaría que integraras esta skill globalmente, es decir, para todos los agentes. Eh, la idea es... que analicemos, si es que nos sirve, o bueno, de hecho quiero implementar. Pero antes de implementar a todos los componentes o donde ... o en todas. partes, quisiera saber cómo quedan las cosas antes. Entonces, quiero que simplemente en una parte del apps que tenemos, así no estoy mal. Para quite. kite, Hola, me refiero a que es una página de preview donde se ven los componentes y demás. Entonces, quiero poder acceder a y ver. ¿Qué tal se ven? Antes de llegar a implementar."

L2 — Skill install used `npx skills add imskyleen/animate-ui -g --all`. The CLI left `references/recipes/` and `references/interactions/` empty; all 41 skill files were re-synced from the upstream tree into `~/.agents/skills/animate-ui` (the source of the `~/.claude/skills/animate-ui` junction).

L3 — Kite has no `components.json` and no Radix/Base UI/React Aria primitives, and runs React 18. The preview therefore follows the skill's path C (tokens + rules with Motion) instead of the shadcn codemod or the `@animate-ui/react` import swap (that package's peer range is React 19).

L4 — User clarification (verbatim): "Lo que quiero ver es una página que ya habían levantado antes que se llama Mo-Motion, creo. O algo de Lab. Pero, ah. Lo que quiero ver es qué tal se ven estas animaciones a diferencia. De cómo lo hacíamos nosotros, no solamente las animaciones sino que los componentes completos. Básicamente lo quiero ver aplicado en una preview. Levantada desde Motion, por eso. La idea no es que modifiques directamente."

L5 — Reworked the deliverable into four complete, state-shared comparison scenes (chat, settings, workspace, usage/notifications) instead of isolated motion demos. The page is linked from `?motion`, remains dev-only, and no product component or product style is modified. The first implementation already had the token and control layer; the scenes replaced the isolated sections.

L6 — User approval and expansion request (verbatim): "Correcto, eh, quiero que abarques absolutamente todo lo que dijiste ahí, y lo hagas con sus agentes en paralelo. Ojalá que sean varios. Con tal de que te demu... bastante poco. Eh, puedes colocar, por ejemplo, tu páginas, tal vez, porque es muy probable que se expandan mucho. en una sola página. Entonces puedes colocar sus páginas como uno. dos. tres. y así."

L7 — Expanded to nine numbered pages with the page map above. The shell owns `frame.tsx`, `AnimateLab.tsx`, `animateLab.css`, `tokens.ts`, `context.ts`, `ui.tsx`, and the page registry. Each page owns its folder and CSS; page 06 may extend `scenes.tsx`; page 07 imports the existing notifications scene without editing it. Parallel workers must not touch shared or production files.

L8 — Pages 02–09 returned complete; the whole tree is type-clean outside page 01. Shared-layer fixes found by the workers: `spring.bounce` is now typed, `transition.shake`/`transition.spin` are exposed, `SceneButton` forwards refs, and `animateLab.css` loads before page CSS so page overrides win at equal specificity. Added `tokens.test.ts` (5 tests) and `routing.test.ts` (2 tests); both pass. Page 01 is the last worker outstanding.


L9 — User request (verbatim): "Ok, ha quedado bastante bien, aunque creo que podríamos mejorar dos frentes, eh, que noto bastante flojitos. Una en la parte del chat. Diría que hay partes que se pueden mejorar. El cómo se va mostrando, por ejemplo, cada... cada texto. Luego están las... ejecución de las tools. O sea, bueno, las turcals. O cuando aparecen componentes en el chat. También. Para esto puedes utilizar primero el laboratorio, es decir, mostrarlo ahí en el laboratorio. Luego ya lo pasaremos a, al chat real, pero primero tenemos que mostrar. Ajustarlo. Y ver cómo queda. En el laboratorio. Otra cosa importante. Eh, creo que falta. Eh, mejorar. En cierta parte la, algunos componentes. Pero son más específicos. Como. Tarjetas, botones. Los noto bastante flojos por esa parte, nuestra , personificación. Ya, entonces, creo que podríamos enfocarlo un poco ahí. Quiero que vayas con esas cosas por ahora."

L10 — Personality pass added as S12/S13 and T13–T15. Three parallel lab workers now own disjoint surfaces: chat (scenes.tsx + scenes-a.css), buttons (ButtonsSection.tsx + controls.css) and cards (cards.tsx + data.css). The Kite column stays the baseline; only the Animate UI column gets the new behavior.


L11 — Personality pass closed. Chat: streamed words 7 + caret 1 at the sampled frame (last word opacity 0.10, y 1.79 mid-entrance), 4 tool rows with durations and chevrons, detail toggle opens 1 disclosure, approval stamp appears after Aprobar. Buttons: primary hover y −1.5, press scale 0.983, save busy → saved, magnetic button translates 2.8/−2.0 with the label at 1.06/−0.76. Cards: project hover y −2.0 with shadow bloom, spotlight matrix3d tilt, agent card with pulse/actions, shared detail opens in both columns. The tool row was enlarged to 28px with 9.5px label for legibility, and the chat live edge now re-scrolls at 120/320 ms so the disclosure never clips. Lab tests 24/24; tsc clean. Screenshots in %TEMP%/opencode/personality.


L12 — Page 10 “Lenguaje visual” built. It compares Actual vs Propuesto across five scenes: shape/surface tokens, selection controls (checkbox/radio/switch), fields, buttons and cards/overlays. Proposed geometry: radius 4/6/8/12/14, control heights 26/32/38, checkbox 16 px radius 4, radio 16 px dot 7, switch 40×22 knob 18, fields 32 px radius 8 with inset + 2 px focus ring, buttons with three heights and a gradient primary, cards radius 12 with cover and layered shadow, panels radius 14. Browser QA: 10 nav items, 5 scenes / 10 panes, 5 checks / 3 radios / 2 switches / 4 fields / 22 buttons / 4 cards; toggles and focus ring verified. Lab tests 25/25; full suite 67 files / 455 tests; tsc clean. Contract written to docs/visual-language.md. Production untouched.


L13 — 10.4 feedback: the proposed blue/cyan primary read with poor contrast. Replaced it with a near-black gradient (#1a2029 → #0b0f14), a light 1 px border, inset highlight and short shadow; hover lightens the surface instead of turning the fill blue, and the accent stays for focus/semantic states. The Actual column keeps the blue primary. Docs updated in docs/visual-language.md. tsc clean; lab 27/27.
