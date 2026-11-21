# Verification

Code: `packages/verify/src/stack.ts`, `selection.ts`.

| Layer | Class | What it does | Runs when |
| --- | --- | --- | --- |
| L0 | `StaticVerifier` | lint and typecheck checks only | always |
| L2 | `GateVerifier` | every check including holdout, invariants, diff monitor | the gate has checks |
| L3 | `RubricVerifier` | a model scores each rubric criterion 0–2; a blocker scored 0 fails the candidate | rubric exists and a model is configured |
| L4 | `RedTeamVerifier` | a fresh-context model looks for gamed checks; a `gamed` verdict is critical and blocks | `redTeam` on and a diff exists |

`verifyStack` runs the layers cheapest first and stops at the first failure. L1 (targeted tests) is the
worker's own `checks` tool; its runs are evidence, not verdicts.

Red team findings can block a pass but never create one. Unparseable model output in L3 marks criteria
unverified rather than passing them.

## Selection

`TournamentSelection` ranks passing, integrity-clean candidates: a judge model picks among compact
summaries when one is available; otherwise (or on judge failure) gate pass ratio, then rubric score, then
smaller diff. With one passing candidate there is nothing to judge.

## After selection

The mission applies the winner's diff to the user's tree and records evidence that every changed file
matches the verified commit (`git diff --quiet <commit> -- <files>`). If applying fails, the mission is
still `passed` (a verified tree exists), the winner's branch is kept, and the proof lists the failure as a
risk.
