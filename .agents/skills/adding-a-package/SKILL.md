---
name: adding-a-package
description: Create a new @bedrock workspace package with the source-first exports, tsconfig, tests and docs it needs. Load before adding a directory under packages/.
---

# Adding a package

1. `mkdir -p packages/<name>/{src,test}`.
2. `package.json` (copy `packages/ledger/package.json` and edit):
   - `"name": "@bedrock/<name>"`, `"version": "0.1.0"`, `"type": "module"`.
   - `exports["."]` must list `"bedrock-source": "./src/index.ts"` **first**, then `types` and `import`
     pointing at `dist/` (ADR-0003). Without it, Node and tsc resolve stale `dist/`.
   - Dependencies at exact versions; workspace deps as `"@bedrock/x": "0.1.0"`. Only depend downward
     (see the layer diagram in `repo-overview`). `protocol` stays dependency-free.
3. `tsconfig.build.json` copied from a sibling (it clears `customConditions`).
4. `src/index.ts` whose first line is a comment saying what the package is for; re-export modules.
5. A test in `test/*.test.ts`. Vitest aliases every workspace name to its `src/index.ts` automatically.
6. `npm install --ignore-scripts` to link it, then commit `package.json` changes with `package-lock.json`.
7. `npm run check && npm test`.
8. Add a row to the table in `README.md`, a section in the right `docs/*.md`, and update
   `.agents/skills/repo-overview/SKILL.md`.
