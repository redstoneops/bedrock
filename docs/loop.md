# The mission loop

Code: `packages/core/src/mission.ts` (`runMission`). Read it top to bottom; the numbered comments match
the steps below.

```
mission_start
 ├─ scout            core/scout.ts       deterministic repo map, commands, context files, toolchain probe
 ├─ snapshot         isolation/snapshot  commit of the dirty working tree (temporary index; user index untouched)
 ├─ gate             gate/compiler.ts    repo commands + --gate commands (+ optional acceptance validation)
 ├─ plan             core/strategist.ts  root node; each round adds distinct approaches
 ├─ round r ─────────────────────────────────────────────────────────────────────────────
 │   ├─ execute      1..N workers in parallel, each in its own worktree on its own approach
 │   ├─ verify       verifyStack per candidate, sequentially (suites share ports and caches)
 │   ├─ select       TournamentSelection among passing candidates → winner → stop
 │   └─ refine       refine brief (ledger + failing checks + ruled-out approaches)
 │                   BudgetPolicy.decide → stop | ask_human | widen | escalate | refine | branch
 ├─ apply            the winner's diff onto the user's tree (3-way fallback, conflicts reported)
 ├─ cleanup          worktrees removed; the best failed candidate's branch is kept for inspection
 ├─ reflect          optional playbook lessons (add-only, scoped to the repo)
 └─ proof            proof.md + proof.json, mission_finish
```

## Workers

`packages/core/src/worker.ts` wraps one pi `Agent`:

- Tools: read, write, the configured edit format (hashline by default), artifact, grep, find, ls, bash, todo,
  ask, ledger, finish, plus `checks` (visible gate, recorded as evidence) and `python` (kernel) when enabled.
- Live stats after every turn: turns, tool calls, repeated-action ratio, turns since progress (an edit, a
  check run or a new ledger fact), failed calls, advisor blockers.
- `shouldStop` ends a worker early: budget exhausted, 15+ turns without progress, or ≥50% repeated calls.
- `advise` runs the advisor every 3 turns; its note is steered into the next turn and blockers are counted.
- `transformContext` masks old tool outputs past ~60% of the model's context window
  (`core/compaction.ts`); full outputs stay in the event log and artifact store.
- `finish` records the worker's claim. It never decides the outcome.

## Rounds and the budget policy

Round 1 runs one worker. If it fails, `DefaultBudgetPolicy` (`core/budget-policy.ts`) sees the signals and
returns an action. Priority order: hard budget → pass → verifier disagreement (escalate) → advisor blockers
(ask) → repetition (branch) → stall (refine) → first failed attempt with parallelism allowed (widen to 2) →
turn cap → similar failing attempts (widen) → continue.

Every round gets a refine brief: failing checks of the best candidate (holdout failures are named only as
"a holdout check"), refuted hypotheses, established facts, and every approach already tried. Rounds rotate
strategist stances, so a second round is never a copy of the first.

## Steering and interrupts

`MissionController` (`core/controller.ts`) is the only live handle a surface holds. `steer(text)` reaches
every active worker at its next turn boundary (queued if none is running); `cancel()` aborts agents,
running commands and checks through one `AbortSignal`, and the final state becomes `cancelled`.

## Final state

`verify/selection.ts#computeFinalState` derives the verdict from gate results only:
`passed` (a candidate passed with a clean integrity report), `unverified` (integrity findings),
`exhausted` (budget), `partial` (some checks passed), `failed`, or `cancelled`.
