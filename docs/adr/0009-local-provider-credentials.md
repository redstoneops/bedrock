# 0009 — Keep provider credentials in user state

Status: accepted (2026-11-26)

## Context

An interactive login needs to survive new Bedrock processes in different repositories. OAuth
also rotates refresh tokens, so two processes cannot safely refresh the same credential independently.

## Decision

Let pi-ai own provider-specific login and refresh. Bedrock stores one credential per provider in
`~/.bedrock/auth.json`. Use an atomic replacement with owner-only permissions and serialize
mutations with a lock directory. The CLI and TUI use the same store.

## Alternatives considered

- Environment variables only: appropriate for CI, not for interactive OAuth or token rotation.
- Native keychain: better protection against accidental file exposure, but would require backend
  implementations per platform. Revisit if Bedrock starts supporting untrusted local work under a
  stronger cross-platform isolation model.

## Consequences

Local credentials are not encrypted at rest. Treat this file like an SSH key. Bedrock disallows
placing it in the workspace; worker path checks and Seatbelt deny access to it. An unsandboxed
process running as the same user can read it. A process killed mid-mutation may leave a stale lock;
remove `auth.json.lock` only after making sure no Bedrock process is using it.
