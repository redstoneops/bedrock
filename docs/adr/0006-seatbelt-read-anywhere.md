# 0006 — Seatbelt allows reads everywhere and restricts writes

Status: accepted (2026-11-20)

## Context

The first Seatbelt profile allowed reads only under system paths and the workspace. In practice login shells
could not read `~/.profile`, toolchains under the home directory failed, worktrees could not read their gitdir
in the primary repository, symlinked dependency directories were unreadable, and test runners could not write
to `$TMPDIR`.

## Decision

Follow Codex's workspace-write mode: `(allow file-read*)`, writes limited to the workspace, its `.bedrock`,
and the temp roots; `.git` and gate material write-protected; network denied by default. Secret files are
kept from the model by the permission policy (`protect-secrets`) rather than by the kernel sandbox.

## Consequences

A sandboxed command can read files outside the workspace (including secrets on disk) and print them; output
redaction and the permission rules are the mitigation. Strict confidentiality needs `--isolation container`.
