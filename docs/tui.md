# Mission Control

Code: `packages/tui/src/`. Built on `@earendil-works/pi-tui` (ADR-0007).

| File | Role |
| --- | --- |
| `view.ts` | `MissionView`: a pure projection of `BedrockEvent`s (strategy, workers, transcript, tool cards, gate rows, ledger, proof) |
| `render.ts` | pure rendering: `renderMission(view, width, height)` plus the panes; Markdown for assistant text |
| `app.ts` | `MissionApp`: `TuiMainScreen` + cockpit component + pi-tui `Editor`, keys and slash commands |
| `virtual-terminal.ts` | an in-memory `Terminal` that replays pi-tui output into a screen buffer, for tests |

## Layout

```
⠴ Bedrock · execute · <goal>                                        $0.42 / $20.00 · 1m12s
status line (scout summary, questions, final state)
STRATEGY                       │ transcript: Markdown text, tool cards, advisor notes,
  ◐ mission                    │ verification results, notices
  ├─ ✗ 1.1 direct fix          │   ✓ $ npm test exit 0 3.1s
  └─ ◐ 2.1 reproduce first     │   ✓ edit src/a.ts +3 -1
GATE 3/4                       │ ▶ PASSED (4/4 visible, 1 holdout)
  ✓ build  ✗ test  🔒 holdout   │
LEDGER  facts 4 · hyp 1 open · evidence 9 · risks 0 · next: widen
┌ editor ─────────────────────────────────────────────────────────────────────────┐
```

Below 76 columns the panes stack. After a mission the proof of work replaces the panes and stays in the
terminal scrollback when you quit.

## Keys

| Key | Action |
| --- | --- |
| Enter | send: a new mission goal when idle, steering while busy, an answer when asked |
| Esc | interrupt the mission (or decline a question) |
| Ctrl+C | interrupt; twice within 1.5s quits |
| Ctrl+K / Ctrl+L | agent hub / ledger pane |
| `/help` `/gate` `/agents` `/ledger` `/proof` `/clear` `/quit` | slash commands |

Editor history, paste handling and line editing come from pi-tui's `Editor`.

## Rendering rules

- Every line is clipped with pi-tui's ANSI-aware `truncateToWidth`; tests assert no line exceeds the width.
- The transcript renders from the end until the pane is full, so long missions stay cheap.
- Tool cards are updated in place by `toolCallId` (running → done), never duplicated.
- The spinner ticks every 250 ms only while busy; differential rendering rewrites only changed lines.

## Testing

Pure renderers are tested as strings (`test/tui.test.ts`). The app is tested on `VirtualTerminal` with real
pi-tui rendering and Editor input (`test/app.test.ts`). For a live check, run under tmux with a scripted
model (see the `tui-components` skill).
