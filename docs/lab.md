# Lab

Code: `packages/lab/src/`. Suites: `evals/`.

## Measuring honestly

`createMissionRunner` (`runner.ts`) runs each task as a real mission in a fresh git repository built from
its fixture. The task's holdout commands are **not** given to the mission. After the mission ends, the
evaluator runs them on the final workspace. `finalState: passed` with a failing holdout is a **false
completion**.

Metrics (`bench.ts#computeMetrics`): pass@1, best@k (holdout-checked), false-completion rate, cost per
solved task, wall clock, tokens.

```sh
bedrock lab run                                  # evals/bedrock-hard/suite.json
bedrock lab run path/to/suite.json --attempts 3 --tags smoke
bedrock lab runs                                 # history under .bedrock/lab/runs
bedrock lab tb refs/terminal-bench/original-tasks --tags hard
```

A suite is JSON: `{ name, description, tasks: [{ id, goal, fixture, gate, holdout, tags }], holdoutTasks }`.
Fixture paths are relative to the suite file. `holdoutTasks` are reserved for promotion decisions.

## Terminal-Bench

`terminal-bench.ts` maps a task directory (`task.yaml`, `run-tests.sh`) to a task whose success is entirely
holdout. Executing them needs each task's Docker image (container isolation); the runner refuses to run them
on the host.

## Evolve

`evolve.ts` runs proposer rounds over harness variants (config plus an opaque patch), keeps a Pareto archive
on success versus cost, and promotes a variant only when it meets the threshold on held-out tasks. The
proposer is a function: a human, a script or a model.

## Status

The bundled suite is a smoke suite, not a benchmark. No Bedrock-vs-baseline numbers exist yet; claims that
a harness feature helps stay unverified until a run shows it.
