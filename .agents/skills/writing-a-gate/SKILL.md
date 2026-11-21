---
name: writing-a-gate
description: How gates are compiled, validated and run, how to add check kinds or detection rules, and the integrity rules you must not weaken. Load before touching packages/gate or gate-related protocol types.
---

# Gates

Read `docs/gate.md` first. Types: `packages/protocol/src/gate.ts`.

## Adding detection for a toolchain

Edit `packages/core/src/scout.ts#detectCommands` (scout) and, for the no-scout fallback,
`packages/gate/src/compiler.ts#detectChecks`. Prefer commands the project already defines. Add a test in
`packages/gate/test/gate.test.ts` and `packages/core/test/mission.test.ts` (scout section).

## Adding an expectation kind

Extend `Expectation` in protocol, then `matchesExpectation` in `runner.ts` (used by both the sync and async
runners). Test passing and failing cases.

## Rules that are not negotiable

- User `--gate` commands are always included and never removed or relaxed.
- Holdout checks never reach a worker: not in prompts, not in the `checks` tool, not in failure names
  (the refine brief says "a holdout check").
- Results bind to `treeHash`; never report a pass without the tree it ran on.
- An acceptance check that passes before the fix is demoted to holdout, not kept as proof.
- Never edit a check to make a mission pass. If a check is wrong, fix it in its own commit and explain why.

## Testing

Use temp git repos (see `workspace(files, git)` in the gate tests). Check both `runGate` and
`runGateAsync` when changing verdict logic.
