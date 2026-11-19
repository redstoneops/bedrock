# 0003 — Packages run from TypeScript source in development

Status: accepted (2026-11-19)

## Context

A monorepo of 16 packages with cross-package imports normally needs either a build step before any
test or dev run (`dist/` wiring, project references) or path aliases duplicated between TypeScript,
Vitest and Node. pi solves this by rewriting relative imports (`rewriteRelativeImportExtensions`) and
running tests from source through Vitest aliases. Bedrock adds a second problem: the CLI must run
without a build, so a developer (or an agent) can try a change immediately.

## Decision

Every workspace package exports a `bedrock-source` condition first:

```json
"exports": { ".": {
  "bedrock-source": "./src/index.ts",
  "types": "./dist/index.d.ts",
  "import": "./dist/index.js"
} }
```

- Node runs with `--conditions=bedrock-source` (the `npm run bedrock` script and the `bedrock` bin
  wrapper both add it), resolving `@bedrock/*` to live TypeScript.
- TypeScript has `"customConditions": ["bedrock-source"]`, so `tsc --noEmit` typechecks source, not
  stale declarations.
- Vitest maps every workspace name to `src/index.ts` in `vitest.config.ts`, so tests never need a
  build.
- `npm run build` compiles `dist/` per package with `customConditions: []`, producing publishable
  output that depends on other packages' `dist/`.

## Alternatives considered

- **Project references + build before test.** Correct, but slow and a common source of "stale dist"
  bugs; pi avoids it for the same reasons.
- **tsconfig `paths` only.** Does not help Node at runtime, so the CLI still needs a build.
- **tsx/ts-node loader.** An extra dependency and a second module-resolution path; Node >= 22.19 can
  strip types natively for the erasable subset, which we already require.

## Consequences

- Source must be *erasable* TypeScript (`erasableSyntaxOnly`): no enums, namespaces, parameter
  properties, `import =`. This is enforced by the root tsconfig.
- Cross-package imports must go through the package name, never a relative path into another
  package's `src/`.
- A stale `dist/` never affects dev because the condition wins. It can affect published installs, so
  `npm run build` is verified in CI before release.
- Consumers outside the repo (npm installs) use `dist/` and do not need the condition.
