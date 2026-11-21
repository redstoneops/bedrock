# 0007 — Mission Control renders on pi-tui's main screen with its Editor

Status: accepted (2026-11-20)

## Context

The cockpit needs flicker-free streaming, real line editing, and a result that survives quitting. pi-tui
offers a main-screen TUI (differential rendering into the scrollback), an alternate-screen viewport TUI with
its own layout system, an `Editor`, and a `Markdown` component.

## Decision

Use `TuiMainScreen`. Bedrock renders the cockpit itself as one component whose height follows the terminal
(`renderMission(view, width, height)`), with pi-tui's `Editor` below it and `Markdown` for assistant text.
The view is a pure projection of `BedrockEvent`s so every surface (TUI, JSONL, replay) agrees.

## Alternatives considered

- `TuiAltScreen` with pi-tui stacks and scroll views: richer scrolling, but the proof of work would vanish on
  exit and the layout engine is a larger surface to depend on.
- A custom renderer: duplicates pi-tui's differential renderer and input handling.

## Consequences

The transcript pane shows the most recent lines; scrolling back through a long transcript is not yet
supported in the TUI (the event log and `bedrock proof` keep everything).
