---
name: atomic-commits
description: Commit conventions for Bedrock: one logical change per commit, Conventional Commits, green checks at every commit, how to split work. Load before staging or committing.
---

# Atomic commits

Every commit must be a single logical change that builds, lints and passes tests. A reviewer should
be able to revert it without dragging unrelated code along.

## Format

```
type(scope): imperative summary

Why this change exists, in one or two sentences. What alternative was rejected, if relevant.

Refs: docs/adr/0007-example.md
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `build`, `ci`.
Scopes: package directory names (`core`, `gate`, `verify`, `tui`, `cli`, `protocol`, ...), or
`repo`, `docs`, `adr`, `skills`, `ci`.
Summary: lower case, no trailing period, at most about 72 characters.

## Splitting work

Bad: `feat(core): mission loop, budget controller, worker pool, advisor`
Good:
1. `feat(protocol): add budget signals and decision types`
2. `feat(core): add budget policy with stall and disagreement heuristics`
3. `test(core): cover budget policy decisions`
4. `feat(core): add mission loop skeleton driven by the budget policy`
5. `docs(loop): document phase transitions and budget decisions`

Rules of thumb:

- A new package skeleton is one commit; its first real feature is another.
- Types + the interface they describe belong together; the implementation using them can follow.
- A bug fix and its regression test are one commit. A refactor needed to enable the fix is separate.
- Formatting churn on untouched files is never mixed in. Prefer `npm run fix` on your paths only.
- Lockfile + `package.json` dependency changes are one commit, alone (`chore(deps): ...`).

## Before committing

```sh
npm run check && npm test     # both must pass, in full
git status --short            # only your files
git diff --staged             # read it as a stranger
```

Never `git add -A` or `git add .` unless the repo is empty; stage explicit paths. Never
`git commit --no-verify`. Never force-push.

## Attribution

When a commit adapts a non-trivial idea from a reference repo, add one line to the body:

```
Idea from oh-my-pi src/tools/read.ts (MIT); reimplemented, not copied.
```

and add the project to `NOTICE.md` if it is not there yet.
