# Gates

A gate is the machine-checkable definition of done, compiled before any solving. Types:
`packages/protocol/src/gate.ts`. Code: `packages/gate/src/`.

## Compiling (`compiler.ts`)

- Commands come from the scout report (`package.json` scripts, Cargo, pytest, go, Makefile), in the order
  install → build → typecheck → test → lint.
- Every `--gate` command is appended as an `acceptance` check and listed in `gate.userSupplied`.
  Nothing removes it.
- Mission constraints become rubric criteria (scored by L3 when a model is configured).
- With no detectable command the gate is empty and says so; the best possible outcome is then `unverified`.

## Holdout

Checks with `visibility: "holdout"` never appear in a worker's prompt or in the `checks` tool. The verifier
runs them, and the TUI shows them locked. The lab goes further: benchmark holdouts are not given to the
mission at all and are run by an independent evaluator after it ends (`packages/lab/src/runner.ts`).

## Acceptance validation (`validate.ts`)

An acceptance check that already passes on the base tree proves nothing. `validateAcceptanceChecks` runs
each acceptance check in a throwaway worktree of the base commit: checks that fail there are kept; checks
that pass are demoted to holdout as non-regression checks.

## Running (`runner.ts`)

- `runGate` (sync) and `runGateAsync` (non-blocking, abortable; used by the verifier and the `checks` tool).
- Results are bound to `treeHash(workspace)`: HEAD plus status plus the diff, so a pass names an exact tree.
- Large outputs become artifacts; the result keeps head and tail.
- The diff monitor (`monitorIntegrity`) flags modified tests, skipped/focused tests (`.skip`, `.only`,
  `pytest.mark.skip`: critical), assertion rewrites, and touched protected paths. Shared dependency dirs and
  `.bedrock/` are ignored.

## Integrity rules

`defaultIntegrity` protects `.git/**`, `.bedrock/gate/**` and `.bedrock/holdout/**`. Rules travel with the
gate and are immutable to refinement (`packages/memory/src/harness-state.ts`).
