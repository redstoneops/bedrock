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
| M0 repo foundation | verified | Monorepo, tooling, CI, protocol contract, skills, ADRs |
| M1 quick agent | tested | `bedrock quick` chat TUI on pi-agent-core; not yet run against a real provider |
| M2 durable core | partial | Event log, ledger, Chest, recovery listing (`bedrock sessions`); missions do not yet run inside the daemon or resume automatically |
| M3 gate + verify | tested | Compiler, async runner, holdout, acceptance validation, diff monitor, L0/L2/L3/L4, computed final state |
| M4 Mission Control | verified | pi-tui app checked live under tmux with a scripted model; no transcript scroll-back or diff view yet |
| M5 parallel + selection | tested | Snapshot worktrees, strategist, budget policy that widens, tournament selection, refine briefs, advisor; no lab numbers yet |
| M6 kernel | tested | Persistent Python kernel as the `python` tool; spawn() requests are queued but not yet executed as sub-agents |
| M7 compounding | partial | Playbook with recall and add-only reflection, guarded harness state; no repeated-run measurement yet |
| M8 lab + evolve | partial | Independent holdout evaluator, smoke suite, Terminal-Bench loader, evolve loop; Terminal-Bench execution needs a container runner |

## Session log

Newest first. One entry per working session: what changed, what is verified, what is not.

### 2026-11-21 — parallel missions, Mission Control, lab

- Mission loop rewritten around rounds of 1..N workers in worktrees branched from a snapshot of the dirty
  working tree; verified winners are applied as diffs (ADR-0005). Strategist, advisor, observation-masking
  compaction, mid-run stall/loop stops, `checks` and `python` tools, evidence for every shell call, proof
  files, reflection.
- Seatbelt now reads anywhere and writes only to the workspace and temp roots (ADR-0006); commands and gate
  checks run without blocking and stop on Esc.
- Mission Control on pi-tui (ADR-0007): `bedrock`, `bedrock run` and `bedrock quick` open it on a terminal.
- Edit formats: hashline (default), str_replace, Codex apply_patch; artifact reader.
- Lab: missions judged by holdouts they never see (ADR-0008); smoke suite; Terminal-Bench loader.
- Verified: `npm run check` clean, 213 tests green, including e2e runs of the real binary with a scripted
  model and a live tmux session showing goal → gate → worktree → verified → applied → proof.
- Not verified: any run against a real provider; any benchmark number; Linux sandboxing.

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
