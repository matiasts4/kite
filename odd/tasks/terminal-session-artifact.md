# One OpenCode session paints the artifacts

Status: confirmed on `feat/ui-composer` at `2053249` (28 October 2026).
The same session also paints the artifacts on the untouched 25 October tree `df914ea`.

## What the checks showed

Without that saved OpenCode session, new terminals stay coherent. Opening that session makes the artifacts appear in each pane where that session is shown. Other sessions can be opened, stretched, and closed without the damage.

The 25 October tree has none of the later terminal experiments, and the session still breaks there. The experiments did not create this trigger. They were judged while this session was on screen, so a fail on those builds does not mean every OpenCode session is broken.

## What was tried, and what not to repeat

Each row is one commit on `feat/ui-composer`. Do not score a new attempt by opening this session.

| Commit | What it changed | Result while this session was in the sample |
| :--- | :--- | :--- |
| `986e308` | Fit before spawn, shorter resize debounce, alt-screen `refresh()`, no `reset()` on a fresh start, removed the fade-in scale. | Launch got worse. Torn first frames. |
| `5ffdb58` | Spawn only after the pane size settles. | New panes stayed blank. The process had already started at 80×24. |
| `41c1d60` | Reserve the session first. Spawn only when the pane is measured. | Fresh panes opened coherent. This closed the launch regression. It did not explain the session that still ghosts. |
| `7d649d8` | Stop local alt-screen refresh. One resize after the write finishes. | OpenCode block marks stayed sliced. |
| `a19ca9a` | Set `lineHeight` to `1`. | The same sliced mark remained on a fresh OpenCode splash from this sample. |
| `19a291b` | Paint with the WebGL renderer. | Did not remove the artifacts. |
| `e4fd0f3` | Revert the WebGL renderer. | Back to the DOM renderer. |
| `2053249` | UTF-8 console and `TERM=xterm-256color` for agent launches. | Not a separate visual pass. Do not treat it as the cause or the cure. |
| `b775ada` | xterm 5.3. One visible pane uses WebGL. Two or more visible panes use canvas on every pane. A lost WebGL context stays on canvas. | Visual pass on 28 October 2026. The same artifacts remain. |

Also rejected, and not applied as the fix: a minimum pane width, and assuming the parent console code page is the cause.

`feat/ui-baseline-1025` at `6a639fe` keeps the 25 October paint and the later non-terminal work. It is a reference. It is not the working line. The session breaks that paint too.

## Operating rule

Do not open this OpenCode session for normal use, and do not open it to decide whether a terminal change worked. Use a new OpenCode session, or any session that has stayed coherent.

## Bitmap renderer

`b775ada` paints one visible pane with WebGL and two or more visible panes with canvas. Parked panes release the addon. Spawn timing, console encoding, and `lineHeight` stayed at their previous values.

Visual pass on 28 October 2026, with the session that paints the artifacts: the same errors remain. This attempt failed. Do not follow it with another line height, another spawn timer, or WebGL on every pane.

## Later debug, when it starts

The next question is what this session writes that a healthy OpenCode session does not. Capture the output, compare, then change one thing.

## Opt-in diagnostic capture

Capture is disabled unless the environment variable is set for the Kite process. In PowerShell, set a dedicated directory before launching the app:

```powershell
$captureDir = Join-Path $env:TEMP "kite-terminal-capture"
New-Item -ItemType Directory -Force $captureDir | Out-Null
$env:KITE_TERMINAL_CAPTURE_DIR = $captureDir
& "E:\path\to\Kite.exe"
```

Each session writes one JSONL file below that directory. Records include the exact output bytes (base64), dimensions, sequence, lifecycle/attach metadata, and counts of selected ANSI markers. **Captures can contain prompts, command output, file paths, tokens, or other secrets. Treat the directory as sensitive and delete it after the comparison.** Do not enable this in normal use or share capture files without reviewing their contents.

For a healthy-vs-poisoned comparison, use a new coherent session as the healthy sample and the known artifact-producing session as the poisoned sample. Keep the pane size and interaction sequence the same, collect both JSONL files, then compare byte lengths, sequence boundaries, and ANSI marker counts before inspecting decoded bytes. Do not use visual output alone as the diagnosis, and do not change terminal rendering while collecting the pair.

Rollback is deliberately narrow: remove the capture helpers and capture fields from `src-tauri/src/terminal.rs`, then remove this section from the task document. The default behavior (capture disabled and unchanged terminal bytes) remains the rollback baseline.
