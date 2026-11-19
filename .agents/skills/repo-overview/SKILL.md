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

1. `cli` resolves config (`~/.bedrock/config.yml` + `.bedrock/config.yml`) and starts a mission.
2. **Scout** (`core/scout.ts`) snapshots the repo: VCS state, languages, build/test commands,
   context files. Writes a `ScoutReport` to the ledger.
3. **Gate compiler** (`gate/compiler.ts`) uses the scout report plus the goal to produce a `Gate`:
   visible checks, holdout checks, invariants, rubric, integrity rules. Acceptance checks are
   validated by running them against the pre-fix tree (`gate/validate.ts`).
4. **Strategist** (`core/strategist.ts`) produces the strategy tree with distinct approaches.
5. **Workers** (`core/worker.ts`) each run a pi `Agent` in their own git worktree
   (`isolation/worktree.ts`) with `tools` + optionally the `kernel`. Every turn can be reviewed by
   the **advisor** (`core/advisor.ts`). Tool calls and messages stream out as `BedrockEvent`s.
6. **Verifier stack** (`verify/`) runs L0 static → L1 targeted → L2 full gate + holdout →
   L3 rubric/SRC → L4 red team, each cheaper layer first. Results are evidence bound to a tree hash.
7. **Budget controller** (`core/budget-policy.ts`) consumes `BudgetSignals` and returns a
   `BudgetDecision` (continue / refine / branch / widen / escalate / prune / ask_human / stop).
8. **Selection** (`verify/select.ts`) ranks passing candidates; **refine** (`core/refine.ts`)
   distills failures for the next rollout; **reflect** (`memory/playbook.ts`) proposes guarded
   playbook deltas.
9. **Proof of work** (`core/proof.ts`) computes the final state in the harness and writes the report.

Every step appends to the session event log (`context/event-log.ts`) and the ledger
(`ledger/store.ts`). The TUI renders events; the daemon replays them after a crash.

## Start reading here

| You want to... | Read |
| --- | --- |
| Understand the vocabulary | `packages/protocol/src/index.ts` and its modules |
| Follow one mission end to end | `packages/core/src/mission.ts`, `mission-loop.ts` |
| Understand "done" | `packages/gate/src/types.ts`, `gate.ts`, `docs/gate.md` |
| Understand verification | `packages/verify/src/stack.ts`, `docs/verification.md` |
| Touch the TUI | `packages/tui/src/app.ts`, `docs/tui.md` |
| Add a tool | `packages/tools/src/registry.ts`, skill `adding-a-tool` |
| Run evals | `packages/lab/src/`, skill `running-evals` |

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
