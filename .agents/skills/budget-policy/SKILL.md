---
name: budget-policy
description: The signals and actions of the budget controller, and how to write, test and evaluate a BudgetPolicy. Load before changing how missions spend compute.
---

# Budget policy

Interface: `BudgetPolicy.decide(snapshot) → { action, reason, parallelism?, question? }`
(`packages/protocol/src/interfaces.ts`). Default: `packages/core/src/budget-policy.ts`.

Signals (all harness-computed): turns, turnsSinceNewFact (turns without an edit, check run or fact),
gatePassRatio and gateTrend, verifierDisagreement, repeatedActionRatio, candidateCount and
candidateDiversity, blockerCount, costUsd, tokens, wallClockMs, attempts.

Actions the mission loop honors: `stop`, `ask_human`, `widen` (next round runs `parallelism` workers),
`escalate` (raises worker effort), `refine`/`branch`/`continue` (next round with the refine brief and a new
stance).

## Writing one

- Keep it pure and synchronous inside `decide`; no model calls.
- Always check `overBudget` first; never spend after a pass.
- Every decision needs a human-readable `reason`; it is shown in the TUI and logged.
- Unit-test each rule with `signalsFrom` snapshots (`packages/core/test/budget-policy.test.ts`).
- Pass it with `runMission({ policy })`, then run the lab before changing the default.
