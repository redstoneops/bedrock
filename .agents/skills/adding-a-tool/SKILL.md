---
name: adding-a-tool
description: Add an agent tool end to end (schema, sandbox policy, result details, card label, tests, docs). Load before writing a new tool or changing a tool's arguments.
---

# Adding a tool

Generic tools live in `packages/tools/src/`; tools that need the gate, ledger or kernel live in
`packages/core/src/tools.ts`.

1. **Schema.** Build parameters with pi-schema (`obj`, `str`, `int`, `opt`, `arr`, `oneOf`) as a module-level
   constant, and type the tool `AgentTool<typeof params, JsonValue | undefined>`. Put descriptions on fields.
2. **Description.** Say when to use it, what it returns, and its failure modes in plain sentences. Tool
   descriptions are prompts; keep them accurate.
3. **Execute.** Signature `(toolCallId, params, signal, onUpdate)`. Treat params as untrusted:
   - resolve paths with `resolveInside(ctx.workspace, path)`;
   - ask the sandbox: `ctx.sandbox.check({ tool, paths | command })`, honoring `deny` and `ask`
     (`ctx.onPermission`);
   - run commands through `runSandboxed` (non-blocking, abortable via `signal`);
   - return failures with `failure(message)` or `isError: true`, never by throwing for expected errors;
   - put structured data in `details: toDetails({...})` (exitCode, additions/deletions feed tool cards).
4. **Output size.** Truncate with `truncateOutput` and store the full text with `ctx.artifacts.put`,
   mentioning the `art_…` handle so the model can use the `artifact` tool.
5. **Register** in `createTools` (or pass via `extraTools` in `runWorker`) and export from `index.ts`.
6. **Card label.** Add a case to `describeToolCall` in `packages/tools/src/describe.ts`.
7. **Policy.** If the tool writes, add its name to `WRITE_TOOLS` in `packages/sandbox/src/policy.ts`; if it only
   reads, to `READ_TOOLS`.
8. **Tests** in `packages/tools/test/` with a temp workspace and a `yolo` sandbox (see `patch.test.ts`):
   happy path, refusal outside the workspace, and the main error message.
9. **Docs:** a row in `docs/tools.md`.

Host-side web tools (`web.ts`, `web-client.ts`) require explicit opt-in and separate permission
checks. Do not enable shell networking to make them work, forward credentials to fetched URLs,
or auto-approve a host-side request under strict permissions.
