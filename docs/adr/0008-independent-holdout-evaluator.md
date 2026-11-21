# 0008 — Benchmarks judge missions with holdouts the mission never sees

Status: accepted (2026-11-20)

## Context

The headline metric is false completion: the harness says PASSED and it is wrong. If the harness's own
verifier runs the benchmark's holdout, a bug in the verifier can hide exactly the failures we want to count.

## Decision

The lab gives a task's visible gate to the mission and keeps its holdout. After the mission ends, the
evaluator runs the holdout itself on the final workspace. A PASSED with a failing holdout is a false
completion. Terminal-Bench tasks map naturally: their tests are copied in only after the agent finishes.

## Consequences

Lab results are comparable across harness variants regardless of verifier changes. Running Terminal-Bench
needs container isolation; the runner refuses to run those tasks on the host.
