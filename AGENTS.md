# AGENTS.md — how to work in this repo

Bedrock is a terminal coding-agent harness for extremely hard, long-horizon tasks, built on pi's
published packages. It is optimized for **success rate on hard tasks**, then cost, then latency.
This file is the entry point for any agent working here. Read it fully before your first edit.

## The one rule

**Nothing counts unless it rests on bedrock.** Every claim about the world ("the bug is in X",
"the tests pass", "it's done") must be backed by evidence the harness can check. In this repo that
applies to *you* too: never report work as finished without running the checks, and never say
"tests pass" without the command output that shows it.

## Commands

```sh
npm install                 # Node >= 22.19, npm workspaces
npm run check               # biome check + tsc --noEmit (must pass before every commit)
npm run fix                 # biome autofix
npm test                    # vitest, all packages
npx vitest run packages/core        # one package
npx vitest run packages/core/test/budget-policy.test.ts   # one file
npm run bedrock -- --help   # run the CLI from source (no build needed)
npm run bedrock -- quick     # interactive quick mode
scripts/fetch-refs.sh       # clone/update reference repos into refs/ (gitignored)
```

Never run `npm install` for a new dependency without pinning an exact version (`save-exact` is set)
and updating the lockfile in the same commit. Never edit `refs/` contents; never commit it.

## Repo map

`packages/*` are npm workspaces named `@bedrock/<dir>`. They run from TypeScript source in dev
through the `bedrock-source` export condition (see [ADR-0003](docs/adr/0003-run-from-source.md)).
`packages/protocol` is the shared vocabulary every package imports; it has no runtime dependencies.

Read, in this order: `packages/protocol/src/` → `packages/core/src/mission-loop.ts` →
`packages/gate/src/compiler.ts` → `packages/verify/src/stack.ts`. See the `repo-overview` skill.

## How work lands here

1. **Study before you build.** Reference implementations are cloned into `refs/` (gitignored).
   Read them; do not import them; do not copy large chunks. See the `studying-refs` skill.
2. **Plan in small, verifiable steps.** If a task has no clear "done", write the check that proves
   it first. That is also how Bedrock itself works (gate first).
3. **Write the test with the feature.** A behavioral change without a test is unfinished work.
4. **Keep docs and skills true.** Update the doc or skill that describes what you changed *in the
   same change*. Out-of-date skills are bugs.
5. **Commit atomically.** One logical change per commit, Conventional Commits, green `check` and
   `test` at every commit. See the `atomic-commits` skill.
6. **Record decisions.** Non-obvious architecture choices get a short ADR in `docs/adr/`.
7. **Measure.** Claims that a harness feature helps are not done until `@bedrock/lab` shows it,
   or the claim is marked unverified.

## Style

- TypeScript strict, ESM only, `erasableSyntaxOnly` (no enums, namespaces, parameter properties).
- Tabs, 120 columns, Biome formatting. No emojis in code, commits, docs or issues.
- One concept per file, named after the concept. Small functions with one job.
- Comments explain *why* (cost, race, decided rule), never *what*.
- No `any` unless a third-party boundary forces it. Validate at trust boundaries only: wire input,
  model tool arguments, config files, and subprocess output.
- Errors are values at seams (`AgentToolResult.isError`, discriminated unions); throw only for
  programmer error.

## Safety

- Never weaken a gate, a holdout check, or an integrity rule to make something pass. That is the
  exact behavior Bedrock exists to prevent. If a check is wrong, fix the check and say why in the
  commit and the Ledger.
- Never commit secrets, `.env` files, `refs/`, `.bedrock/`, build output or eval artifacts.
- Destructive git operations are reserved for the human. Do not `git reset --hard`, `git clean -fd`
  or force-push.
- The sandbox package's policies are load-bearing: do not add a bypass "temporarily".

## Skills

Skills live in `.agents/skills/<name>/SKILL.md`. Load the one matching your task:

| Skill | Use when |
| --- | --- |
| `repo-overview` | You need the map: packages, data flow, where to start reading |
| `dev-workflow` | Setup, build, test, run, debug, common pitfalls |
| `atomic-commits` | Before committing anything |
| `studying-refs` | Before designing a subsystem; how to use `refs/` and attribute ideas |
| `adding-a-package` | Creating a new workspace package |
| `adding-a-tool` | Adding an agent tool (schema, policy, TUI card, tests) |
| `writing-a-gate` | Gate compiler, checks, holdouts, integrity rules |
| `writing-a-verifier` | Verifier layers, selection, final state |
| `tui-components` | Mission Control components on pi-tui |
| `running-evals` | Lab runs, ablations, reading results |
| `writing-adrs` | Recording a decision |

If a skill is wrong, fix it in the same commit as the code that made it wrong.

## Definition of done for an agent session

- `npm run check` and `npm test` pass; paste the tail of the output in your report.
- New behavior has tests. Changed behavior has updated docs/skills.
- Commits are atomic and conventional.
- Your final message states what is verified, what is not, and what you deliberately left out.
