# Progress

A short, honest log of what exists, what is verified, and what is not. Keep it current: the next
agent trusts this file.

## Status legend

- **verified** — implemented, tested in CI, and exercised by hand at least once.
- **tested** — implemented and covered by unit/integration tests; not yet used in a real run.
- **partial** — some of it works; the gap is stated.
- **planned** — designed in docs/PRD, not implemented.

## Milestones

| Milestone | State | Notes |
| --- | --- | --- |
| M0 repo foundation | in progress | Monorepo, tooling, CI, protocol contract, skills, ADRs |
| M1 quick agent | planned | `bedrock quick` on pi-agent-core |
| M2 durable core | planned | Event log, ledger, daemon, recovery, checkpoints |
| M3 gate + verify | planned | Compiler, runner, holdout, L0–L2, computed final state |
| M4 Mission Control | planned | Strategy tree, gate, ledger, agent hub, diff, steering |
| M5 parallel + selection | planned | Worktrees, strategist, budget controller, RTV, PDR, advisor |
| M6 kernel | planned | Persistent kernel, context as a variable, spawn() |
| M7 compounding | planned | Playbook, guarded refinement, red team |
| M8 lab + evolve | planned | Terminal-Bench adapter, dashboard, evolve loop |

## Session log

Newest first. One entry per working session: what changed, what is verified, what is not.

### 2026-11-19 — foundation

- Cloned all reference repos into `refs/` (gitignored).
- Scaffolded 16 workspace packages, root tooling (Biome, TypeScript 7, Vitest, husky, CI).
  Packages run from TypeScript source through the `bedrock-source` export condition.
- Added `@bedrock/protocol`: ids, missions, strategy trees, gates and check results, ledger
  records, the `BedrockEvent` union, permission decisions, config defaults, and the pluggable
  interfaces (`GateProvider`, `Verifier`, `SelectionStrategy`, `BudgetPolicy`, `Strategist`,
  `Refiner`).
- Tests: `packages/protocol/test/protocol.test.ts` (ids, config defaults, entry summaries).
- Verified: `npm run check` and `npm test` green.
- Not verified: everything else. No provider calls have been made; no real mission has run.
