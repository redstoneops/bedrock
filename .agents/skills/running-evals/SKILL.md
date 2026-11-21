---
name: running-evals
description: Run benchmark suites with the lab, add a task to evals/bedrock-hard, read results, and follow the ablation protocol. Load before claiming a harness change helps.
---

# Running evals

Read `docs/lab.md`. A claim that a feature helps is unverified until a lab run shows it.

```sh
bedrock lab run                                    # bundled smoke suite, needs a provider key
bedrock lab run evals/bedrock-hard/suite.json --attempts 3
bedrock lab runs                                   # .bedrock/lab/runs/<run>/{run.json,attempts.jsonl}
```

## Adding a task

1. `evals/bedrock-hard/fixtures/<id>/` with the starting code and a visible test that fails.
2. A `holdout.js` (or equivalent) that checks generality the visible test does not: edge cases, no input
   mutation, no special-casing. The mission never sees it.
3. Confirm: the visible test fails on the fixture; a real fix passes both; a narrow fix passes only the
   visible test.
4. Add the task to `suite.json` (`id`, `goal`, `fixture`, `gate`, `holdout`, `tags`).
5. Extend `packages/lab/test/runner.test.ts` if the task exercises a new failure mode.

## Ablation protocol

Change one variable (e.g. `--no-advisor`, `--parallel 1`, `edits.default: patch`), run the same suite with
the same attempts and models, compare pass@1, best@k, false-completion rate and cost per solved task, and
record the run ids in the commit or ADR that changes a default. Promotion decisions use only
`holdoutTasks`.
