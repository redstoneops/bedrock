# Configuration

Precedence: built-in defaults (`packages/protocol/src/roles.ts#defaultConfig`) < `~/.bedrock/config.yml` <
`.bedrock/config.yml` < command-line flags. Unknown keys produce a warning. Loader:
`packages/cli/src/config.ts`.

```yaml
roles:
  default: anthropic/claude-sonnet-5          # any provider/model from `bedrock models`
  roles:
    worker:     { model: anthropic/claude-opus-5-5, effort: high, fallback: [openai/gpt-5.5] }
    scout:      { model: anthropic/claude-haiku-4-5, effort: low }
    strategist: { effort: high }
    advisor:    { model: openai/gpt-5.5, effort: medium }
    verifier:   { effort: high, requireDifferentFamily: true }
    judge:      { requireDifferentFamily: true }
    red_team:   { model: google/gemini-3.8-flash, requireDifferentFamily: true }
    reflector:  { effort: medium }
loop:
  maxParallelWorkers: 4      # per round; --parallel
  workerTurnCap: 120         # --turns
  advisor: true              # --[no-]advisor
  redTeam: true              # --[no-]red-team
  kernel: false              # --kernel
budget:
  usd: 20                    # --max-usd; hard limit enforced by the harness
  wallClockMs: 14400000
edits:
  default: hashline          # hashline | str_replace | patch
permissions: standard        # yolo | standard | strict; --permissions
isolation: worktree          # worktree | copy | container; --isolation
containerImage: node:22
memory:
  playbook: true             # recall lessons and reflect at the end
```

Roles resolve to models through pi-ai's catalog. A stale model id degrades to the default role's model, then
to any available model; an empty catalog is an error. `requireDifferentFamily` drops same-provider
fallbacks for that role.

`--max-attempts` (default 3) is the total number of workers across all rounds.

## Provider authentication

Use `bedrock providers` to see which providers support interactive OAuth, API keys, or ambient
credentials. Sign in with `bedrock login openai oauth` (ChatGPT), `bedrock login anthropic oauth`
(Claude), or `bedrock login deepseek api-key`. OAuth access depends on your account and provider.
`bedrock logout <provider>` removes the local credential; it does not revoke upstream tokens or
unset environment variables.

Keys and tokens live in `~/.bedrock/auth.json` (owner-only, not encrypted). Keep `BEDROCK_HOME`
outside the project. Only run trusted code when shell or verification commands run without OS
isolation. See [ADR-0009](adr/0009-local-provider-credentials.md).

## Environment

| Variable | Effect |
| --- | --- |
| provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) | credentials, read by pi-ai |
| `BEDROCK_HOME` | overrides the user authentication directory (default `~/.bedrock`) |
| `BEDROCK_SCRIPT=file.json` | replace every model with a scripted one (demos and tests only) |
| `PYTHON` | interpreter for the kernel (default `python3`) |
