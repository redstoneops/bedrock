# Isolation

Code: `packages/isolation/src/`. Decision record: ADR-0005.

1. **Snapshot.** `snapshotCommit(repo)` builds a commit of the working tree with a temporary index:
   tracked changes and untracked, non-ignored files are included, `.bedrock/` is excluded, and the user's
   index and HEAD are untouched. A clean tree returns HEAD.
2. **Worktrees.** Each worker gets `createWorktree` on a `bedrock/<mission>-r<round>-w<n>-…` branch under
   `~/.bedrock/worktrees/<repo>-<hash>/`, outside the repository so nested checkouts never become
   embedded repos.
3. **Dependencies.** `linkDependencyDirs` symlinks `node_modules`, `.venv` and `venv` (root and one level of
   `packages/`, `apps/`, `libs/`) from the primary checkout. Build output dirs are not shared.
4. **Candidates.** `commitAll` commits everything except the dependency links; `diffBetween` and
   `diffStatBetween` describe the candidate against the snapshot.
5. **Apply.** `applyCandidate` applies `snapshot..winner` to the primary tree, falling back to a three-way
   apply and reporting conflicts instead of overwriting user edits made during the mission.
6. **Cleanup.** Worktrees are removed; branches are deleted except the best failed candidate (for
   inspection) and an unapplicable winner.

Non-git directories fall back to in-place editing with one worker at a time; `copyWorkspace` exists for
callers that want a copy. `checkpoint`/`rewind`/`mergeCandidate` provide checkpoint commits inside a
worktree.
