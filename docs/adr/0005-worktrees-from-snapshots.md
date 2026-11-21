# 0005 — Workers run in worktrees branched from a working-tree snapshot

Status: accepted (2026-11-20)

## Context

Parallel workers need isolation, and the user's checkout must not change until a result is verified. Users
often start a mission with uncommitted work, which `git worktree add HEAD` would silently drop. Worktrees
inside the repository (`.bedrock/worktrees`) showed up in `git status` and were picked up by `git add -A` as
embedded repositories. Worktrees also lack gitignored dependency directories, so `npm test` failed there.

## Decision

- Snapshot the working tree into a commit built with a temporary index (`GIT_INDEX_FILE`), including
  untracked non-ignored files and excluding `.bedrock/`. The user's index and HEAD are never touched.
- Create one worktree per worker from that snapshot under `~/.bedrock/worktrees/<repo>-<hash>/`.
- Symlink `node_modules`/`.venv`/`venv` from the primary checkout; never share build output.
- Apply the verified winner as a diff (three-way fallback); never commit on the user's behalf.

## Alternatives considered

- Stash and restore: mutates the user's state and races with their edits.
- Copy the directory per worker: slow for large repos and cannot produce a clean diff.
- Reinstall dependencies per worktree: correct but minutes per worker.

## Consequences

- Non-git directories fall back to one in-place worker.
- Shared dependency directories mean a worker that mutates `node_modules` affects others; acceptable for
  now, revisit with container isolation.
