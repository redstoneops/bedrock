# Architecture

Bedrock is a monorepo of small packages around one shared contract. This page is the map; each
subsystem has its own page linked at the bottom.

## Shape

```
                      ┌─────────────────────────────────────────┐
                      │                @bedrock/cli              │
                      │  interactive · run · quick · -p/--json   │
                      │  rpc · lab                               │
                      └───────────┬───────────────┬─────────────┘
                                  │               │
                        ┌─────────▼───────┐ ┌─────▼──────┐
                        │  @bedrock/tui   │ │@bedrock/lab│
                        │ Mission Control │ │ Beacon/Anvil│
                        └─────────┬───────┘ └─────┬──────┘
                                  │               │
                      ┌───────────▼───────────────▼─────────────┐
                      │            @bedrock/daemon              │
                      │  session ownership · attach/detach ·    │
                      │  recovery · heartbeats                  │
                      └───────────┬─────────────────────────────┘
                                  │
                      ┌───────────▼─────────────────────────────┐
                      │             @bedrock/core               │
                      │  mission loop · strategist · workers    │
                      │  budget policy · advisor · proof        │
                      └──┬──────┬──────┬──────┬──────┬──────────┘
                         │      │      │      │      │
               ┌─────────▼┐ ┌───▼───┐ ┌▼─────┐ ┌▼──────────┐
               │ verify   │ │ gate  │ │memory│ │  kernel   │
               │ L0..L4   │ │Recipe │ │Chest │ │  Python   │
               └────┬─────┘ └───┬───┘ └──────┘ └───────────┘
                    │           │
        ┌───────────▼───────────▼────────────┐
        │ tools · sandbox · isolation ·      │
        │ ledger · context · ai              │
        └───────────────┬────────────────────┘
                        │
                 ┌──────▼──────┐
                 │  protocol   │  types only, no I/O
                 └─────────────┘
```

Dependencies point downward only. `protocol` is the shared vocabulary: missions, gates, ledger
entries, events, permission decisions, and the pluggable interfaces (`BudgetPolicy`, `Verifier`,
`GateProvider`, `SelectionStrategy`, `Strategist`, `Refiner`). Every seam the lab wants to evolve is
an interface here.

## The two authorities

Bedrock separates **producing** from **judging**:

1. **Workers** (`core/worker.ts`) change the world: they read, edit, run commands, and write claims
   to the ledger. They cannot mark anything done.
2. **The harness** decides the final state (`verify/final-state.ts`) from gate results bound to a
   tree hash. A model's sentence "done" is just another event.

Between them sits the **Gate** (`gate/`), compiled before solving. It contains visible checks,
hidden holdout checks, invariants, a rubric, and integrity rules. Workers see the visible part; the
verifier runs the rest.

## State

Three stores, one owner (the daemon process for a mission):

| Store | Form | Purpose |
| --- | --- | --- |
| Event log | append-only JSONL per session | full replay, TUI, crash recovery, lab traces |
| Ledger | SQLite (`node:sqlite`) | typed beliefs with evidence refs; queried, not dumped into prompts |
| Artifacts | content-addressed files | large tool output, logs, diffs, snapshots |

The prompt is a **view** assembled per turn (`context/prompt.ts`): system prompt, mission, gate
summary, relevant ledger slices, active strategy, recent turns, retrieved playbook entries. Compaction
writes a summary plus pointers; raw history stays queryable.

## Compute

The budget controller (`core/budget-policy.ts`) is a pure function over `BudgetSignals` returning one
of: `continue`, `refine` (distill failures, restart), `branch` (new strategy), `widen` (more workers),
`escalate` (stronger model/effort), `prune`, `ask_human`, `stop`. It is pluggable precisely so
`bedrock lab evolve` can propose better policies and prove them on held-out tasks.

## Durable by default

Every mission runs in a recoverable process owned by `bedrockd`. The TUI and CLI attach and detach
freely. After a crash, the daemon replays the event log, reloads the ledger, restores the last
verified checkpoint, and continues. Hard limits (turns, tokens, cost, wall clock) are enforced by the
harness, not requested from the model.

## Subsystem docs

- [The loop](loop.md) — rounds, workers, budget decisions, steering, final state
- [Gates](gate.md) — compiling "done", holdouts, acceptance validation, diff monitor
- [Verification](verification.md) — L0–L4, selection, applying the winner
- [Tools](tools.md) — hashline, str_replace, apply_patch, checks, artifacts, shell
- [Isolation](isolation.md) — snapshots, worktrees, shared dependencies, apply
- [Context, ledger, memory, kernel, daemon](context.md)
- [Integrity and security](security.md) — permissions, Seatbelt, redaction, audit
- [Mission Control](tui.md) — layout, keys, rendering rules, testing
- [Lab](lab.md) — suites, the independent evaluator, Terminal-Bench, evolve
- [Configuration](configuration.md) — every config key and flag
- [pi integration](pi-integration.md) — the pi APIs Bedrock depends on
