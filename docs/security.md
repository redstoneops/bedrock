# Integrity and security

Code: `packages/sandbox/src/`.

## Permission presets (`policy.ts`)

Ordered rule tables; the first match wins and its id is shown and audited.

| Preset | Behavior |
| --- | --- |
| `yolo` | allow everything (still inside the OS sandbox when one applies) |
| `standard` | deny secrets and gate material; allow reads and workspace writes; allow read-only shell; ask for other shell commands |
| `strict` | deny the shell, ask before reads |

Autonomous runs cannot ask, so inside an isolated workspace an `ask` becomes `allow`.

## OS sandbox (`seatbelt.ts`, `sandbox.ts`)

On macOS, commands run under `/usr/bin/sandbox-exec` with a profile adapted from Codex: deny by default,
**read anywhere**, write only to the workspace, its `.bedrock`, and the temp roots; `.git` and gate material
are write-protected; network denied unless allowlisted. Reads are open because toolchains live under the
home directory and worktrees read their gitdir and shared dependency dirs (ADR-0006); secret files are kept
from the model by the permission rules.

`--isolation container` wraps commands in `docker run` with `--network none` by default.

`runAsync` streams output, kills the whole process group on abort or timeout, and never blocks the event loop.

## Secrets (`redact.ts`)

Provider keys, GitHub/AWS/Google/Slack tokens, JWTs, private keys, `*_TOKEN=`/`*_SECRET=` assignments and
`Authorization:` headers are redacted from command output and audit records.

## Audit (`audit.ts`)

Every shell decision (allowed or denied, executed or not) is appended to `.bedrock/audit.jsonl`.

## Integrity

- Workers cannot edit gate or holdout material (`protect-gate` rule plus Seatbelt protected paths).
- The diff monitor flags test edits, skipped tests and rewritten assertions; critical findings block a pass.
- L4 red team reviews passing candidates for gamed checks.
- Refinement cannot touch the gate, verifier, integrity rules or evals.
- The lab measures false completion with holdouts the mission never sees.

## Not yet implemented

Linux Landlock/bubblewrap wrapping, a network proxy for host allowlists, and dual-LLM quarantine of
untrusted content are designed (PRD §7) but not built. On Linux today, use `--isolation container`.
