---
name: tui-components
description: Change Mission Control (view model, rendering, keys, the pi-tui app) and verify it with string tests, the virtual terminal and a live tmux run. Load before touching packages/tui.
---

# TUI work

Read `docs/tui.md`. Three layers, keep them separate:

1. **State** (`view.ts`): handle a new `BedrockEvent` in `MissionView.apply`. Pure; no timers, no I/O.
2. **Rendering** (`render.ts`): pure functions of `(view, width, height)`. Clip every line with `fit` or
   `truncateToWidth`; never emit a line wider than the width. Use `paint` for color.
3. **App** (`app.ts`): keys, slash commands, Editor wiring. Global keys go through `#globalKey` using
   `matchesKey(data, "ctrl+x")`.

## Test at three levels

- String tests in `test/tui.test.ts`: build a view, call `renderMission`, strip ANSI with
  `stripVTControlCharacters`, assert content and `visibleWidth(line) <= width`.
- App tests in `test/app.test.ts`: `new MissionApp({ terminal: new VirtualTerminal(100, 28), tickMs: 0 })`,
  `app.tui.renderNow(true)`, type with `terminal.type(...)`, read `terminal.transcript()`.
  A lone Esc is dispatched after pi-tui's escape timeout: wait ~150 ms.
- Live: run a scripted mission under tmux and look at it.

```sh
cat > /tmp/script.json <<'JSON'
{"tokensPerSecond": 20, "steps": [
  {"text": "Reading **the code**.", "tools": [{"name": "read", "args": {"path": "add.js"}}]},
  {"tools": [{"name": "finish", "args": {"summary": "done", "checks": [], "unverified": []}}]}
]}
JSON
tmux new-session -d -s br -x 110 -y 32 "cd /path/to/repo && BEDROCK_SCRIPT=/tmp/script.json node $PWD/packages/cli/bin/bedrock.js"
tmux send-keys -t br "make npm test pass" Enter; sleep 3; tmux capture-pane -t br -p
tmux kill-session -t br
```
