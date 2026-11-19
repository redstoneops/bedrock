# 0002 — Node.js and npm workspaces, not Bun

Status: accepted (2026-11-19)

## Context

The two input drafts disagree: the first proposes Bun (fast installs, built-in test runner,
single-binary compile), the other follows pi's conventions (Node >= 22.19, npm workspaces, Vitest).
pi targets Node and npm; oh-my-pi uses Bun. The machine this was bootstrapped on has Node 26 and npm
11 and no Bun.

Bedrock depends on pi packages for providers, the agent loop and the TUI. Those packages are built,
published and tested for Node. They use `node:*` APIs, and pi-tui has native modules with per-platform
prebuilds.

## Decision

Use **Node.js >= 22.19** and **npm workspaces**. TypeScript 7, Biome 2, Vitest 4, husky.

Rationale: one runtime for the whole stack, maximum compatibility with pi's published artifacts, no
native-module surprises, and a contributor path that matches the base project. Bun can still run the
repo, but it is not the supported or tested path.

## Alternatives considered

- **Bun** for speed and `bun build --compile` binaries. Rejected for v1: it would make pi-package
  compatibility a research project, and we do not need single-binary distribution yet.
- **pnpm** workspaces. Faster and stricter, but adds a second package manager to explain and pi uses
  npm; unnecessary divergence.

## Consequences

- `engines.node >= 22.19.0` in the root and every package.
- `node:sqlite`, `node:test`-free tests (we use Vitest), `node --watch` for dev loops.
- Single-binary distribution, if ever needed, becomes a packaging task (`node --experimental-sea` or
  a Bun-compiled release built from the same source).
- Revisit if npm workspace install time becomes a real bottleneck in CI, in a new ADR with numbers.
