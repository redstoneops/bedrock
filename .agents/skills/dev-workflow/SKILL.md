---
name: dev-workflow
description: Setup, build, test, run and debug Bedrock locally. Load when you need exact commands, are setting up the repo, or hit a tooling pitfall (source imports, vitest, tsconfig, husky, subprocess tests).
---

# Dev workflow

## Setup

```sh
node -v            # must be >= 22.19; developed on 26
npm install        # installs workspaces, sets up husky via prepare
scripts/fetch-refs.sh   # optional: reference repos into refs/ (gitignored)
```

If `npm install` fails on a postinstall script, use `npm install --ignore-scripts` then
`npx husky`. Lifecycle scripts are not required to run anything.

## The checks

```sh
npm run check   # biome check . && tsc --noEmit -p tsconfig.json
npm test        # vitest run (all packages, from source)
```

Both must pass before every commit. `npm run check` is fast (a few seconds); the whole suite should
stay under about a minute. If you add a slow test, mark it or move it behind a suite filter.

Run a subset:

```sh
npx biome check packages/core
npx vitest run packages/core
npx vitest run packages/core/test/budget-policy.test.ts -t "widens when stalled"
```

## Running the CLI

```sh
npm run bedrock -- --help
npm run bedrock -- quick "fix the failing test in src/foo.test.ts"
npm run bedrock -- run --goal "..." --gate "npm test"
```

`npm run bedrock` runs `node --conditions=bedrock-source packages/cli/src/main.ts`. No build step:
Node strips TypeScript types directly. Two consequences:

- Only *erasable* TypeScript syntax is allowed in `src/`: no `enum`, `namespace`, parameter
  properties, or `import =`. Use `const` objects and unions instead.
- Import workspace packages by name (`@bedrock/gate`), not by relative path across packages.

## How source imports resolve

Workspace packages export a `bedrock-source` condition pointing at `./src/index.ts`, before the
`dist` entries. Node and tsc both use it, so `@bedrock/x` always resolves to source during
development (ADR-0003). `npm run build` emits `dist/` for publishing with that condition removed.

If you get "does not provide an export named ...", you are probably importing a symbol that does not
exist in the installed pi version. Check the real declarations:

```sh
sed -n '1,80p' node_modules/@earendil-works/pi-ai/dist/index.d.ts
grep -rn "export declare function" node_modules/@earendil-works/pi-agent-core/dist/*.d.ts
```

## Testing without API keys

pi-ai ships a faux provider. Use it; never call a real provider in tests.

```ts
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })])]);
```

The same pattern proves prompt assembly: assert on what the faux provider received
(`TranscriptContext`), not on network calls.

## Running the real stack without keys

`BEDROCK_SCRIPT=path/to/script.json` replaces every model with a scripted one (`packages/cli/src/scripted.ts`):

```json
{ "tokensPerSecond": 20, "steps": [
  { "text": "Reading the code.", "tools": [{ "name": "read", "args": { "path": "src/a.ts" } }] },
  { "tools": [{ "name": "finish", "args": { "summary": "done", "checks": [], "unverified": [] } }] }
] }
```

`packages/cli/test/e2e.test.ts` drives the real binary this way through scout, gate, worktree,
verification, apply and proof. Set `HOME` to a temp dir in such tests: worktrees go to
`~/.bedrock/worktrees`.

## Tests that touch the filesystem or processes

- Work in a temp dir: `mkdtempSync(join(tmpdir(), "bedrock-"))`; never write inside the repo.
- For git behavior, `execFileSync("git", [...], { cwd })` on a temp repo; skip with
  `it.skipIf(!hasGit)` if git is missing.
- For the kernel, skip unless `python3 -c "import jupyter_client"` succeeds; the suite must pass on a
  machine without Python.
- Never spawn the real `bedrock` TUI in tests. Render components to strings instead.

## Husky / commits

`.husky/pre-commit` runs `npm run check` (tests run before committing by hand and in CI; temp-repo tests
contend with git's index lock inside a hook). In a linked git worktree, husky is not
installed automatically; run `npm install` (or `npx husky`) inside the worktree once, or run the
checks manually before committing.

## Common pitfalls

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ERR_UNKNOWN_FILE_EXTENSION` | running `.ts` without type-stripping | run through `npm run bedrock` or `node --conditions=bedrock-source` |
| tsc sees `dist/*.d.ts` of a workspace package instead of source | missing `bedrock-source` in exports, or a stale `dist/` | check `package.json#exports`, delete `dist/` |
| biome reformats unrelated files | you ran `biome check --write .` on the repo root | format only your paths, or accept the diff if it is formatting-only and separate it |
| vitest can't resolve `@bedrock/x` | the package is missing from `workspaces` or has no `src/index.ts` | check `package.json` and `vitest.config.ts` aliases |
| `node:sqlite` warning | Node < 22.5 | upgrade Node |
