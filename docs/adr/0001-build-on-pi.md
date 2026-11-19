# 0001 — Build on pi, do not rewrite it

Status: accepted (2026-11-19)

## Context

Bedrock needs an agent loop, a unified multi-provider LLM API, streaming, tool schemas, and a
differential-rendering TUI. pi already ships all of these as published, MIT-licensed packages
(`@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui`, currently 1.5.2). oh-my-pi and prime-agent both
demonstrate that substantial harnesses can be built on top of pi without forking it.

The risk of depending on pi is that we may need changes upstream does not have (richer TUI primitives,
new loop hooks). The risk of forking is a permanent merge burden and a split ecosystem — the exact
failure mode the reference repos warn about.

## Decision

Depend on pi's published packages at pinned versions. Do not fork or vendor them.

- Providers, models, streaming, cost accounting: `@earendil-works/pi-ai`.
- Base agent loop, tools, events, steering: `@earendil-works/pi-agent-core`.
- TUI primitives and differential rendering: `@earendil-works/pi-tui`.
- Tool parameter schemas: `@earendil-works/pi-schema` (the schema system pi's tool types use).

All Bedrock-specific behavior lives in our own packages and is expressed through pi's extension
points: `AgentOptions` hooks (`beforeToolCall`, `afterToolCall`, `transformContext`, `prepareRequest`,
`finishTurn`), custom `AgentTool` implementations, custom `StreamFn`s, and pi-tui components.

**Fork policy.** A fork requires an ADR that names (1) the missing capability, (2) why an upstream
PR is not viable now, (3) how the fork is kept isolated (own package, upstream commit noted), and
(4) how we will drop it. Until then, work around limitations in our layer.

## Alternatives considered

- **Fork pi** (the oh-my-pi path). Gives full control, but the reference fork carries a large diff
  and duplicates upstream work. Rejected for v1.
- **Vendor pi-tui only** to accelerate TUI work. Rejected: pi-tui already has the primitives we need;
  port improvements as components on top.
- **Write our own loop and providers.** Weeks of work for no differentiation; verification, not the
  loop, is our product.

## Consequences

- We must track pi releases and keep exact versions; upgrades are reviewed commits.
- pi's `AgentState`/event model is our source of truth for conversation state; our event log is a
  projection of it, not a replacement.
- If pi's loop blocks a required behavior (for example, per-turn context rewrites that pi does not
  support), we implement it in a `StreamFn` or `transformContext` hook first, and only then consider
  a fork.
- Every pi API we rely on is listed in `docs/pi-integration.md`, updated when we move versions.
