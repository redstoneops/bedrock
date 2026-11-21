---
name: repo-overview
description: Map of the Bedrock monorepo: packages, dependency layers, data flow through the mission loop, and where to start reading. Load this first when you are new to the repo or need to find the right package.
---

# Bedrock repo overview

Bedrock is a monorepo of npm workspaces (`packages/*`, named `@bedrock/<dir>`) built on pi's
published packages. Everything runs from TypeScript source in dev; `npm run check` typechecks all
of it, `npm test` runs every package's vitest suite.

## Dependency layers

```
cli ── tui ── daemon ── lab
 │      │        │
 └──────┴────────┴── core ── memory, kernel, verify ── gate ── tools ── sandbox
                        │                                  │
                        └── ai, ledger, context, isolation ─┴── protocol
```

`@bedrock/protocol` has no runtime deps. Nothing imports "upward": `tools` never imports `core`.
If you need shared vocabulary, add it to `protocol` (types only, no I/O).

## Data flow of one mission

1. `cli/src/main.ts` resolves config (`cli/src/config.ts`) and builds a runtime (`cli/src/runtime.ts`).
   With a TTY it opens Mission Control (`tui/src/app.ts`); otherwise it prints prose or JSONL.
2. **Scout** (`core/scout.ts`): VCS state, languages, build/test commands, context files, toolchain.
3. **Snapshot** (`isolation/snapshot.ts`): the dirty working tree becomes a commit; workers branch from it.
4. **Gate** (`gate/compiler.ts`, optional `gate/validate.ts`): checks, holdout, invariants, integrity.
5. **Rounds** (`core/mission.ts`): the strategist (`core/strategist.ts`) picks distinct approaches; each
   worker (`core/worker.ts`) runs a pi `Agent` in its own worktree (`isolation/worktree.ts`) with tools from
   `tools/` plus `core/tools.ts` (`checks`, `python`), the advisor (`core/advisor.ts`) and compaction
   (`core/compaction.ts`).
6. **Verify** (`verify/stack.ts`) each candidate; **select** (`verify/selection.ts`); **apply** the winner.
7. Between rounds the **budget policy** (`core/budget-policy.ts`) decides; refine briefs come from the
   ledger (`ledger/ledger.ts`) and are written to the Chest (`memory/chest.ts`).
8. **Reflect** (`core/reflect.ts` → `memory/playbook.ts`) and **prove** (`core/proof.ts`).

Every step emits a `BedrockEvent` (`protocol/events.ts`) into the session log (`context/event-log.ts`); the
TUI's `MissionView` is a projection of the same stream. Live control goes through `core/controller.ts`.

## Start reading here

| You want to... | Read |
| --- | --- |
| Understand the vocabulary | `packages/protocol/src/` |
| Follow one mission | `packages/core/src/mission.ts`, `docs/loop.md` |
| Understand "done" | `packages/gate/src/compiler.ts`, `runner.ts`, `docs/gate.md` |
| Understand verification | `packages/verify/src/stack.ts`, `docs/verification.md` |
| Touch the TUI | `packages/tui/src/app.ts`, `docs/tui.md` |
| Add a tool | `packages/tools/src/index.ts`, skill `adding-a-tool` |
| Run evals | `packages/lab/src/runner.ts`, skill `running-evals` |

## Naming

Packages use functional names. The product language (Recipe, Crafter, Observer, Chest, ...) survives
as component vocabulary in docs and class names:

| Codename | Where |
| --- | --- |
| Recipe | `@bedrock/gate` |
| Crafter, Repeater, Pistons | `@bedrock/core` |
| Observer, Comparator | `@bedrock/verify` |
| Chest, Bookshelf | `@bedrock/memory` |
| Hopper | `@bedrock/context` |
| Obsidian | `@bedrock/sandbox` |
| Beacon, Anvil | `@bedrock/lab` |
