---
name: studying-refs
description: How to use the gitignored reference repositories in refs/ (pi, oh-my-pi, prime-agent, codex, ...), what to study in each for each subsystem, and the license/attribution rules.
---

# Studying reference repos

`refs/` holds shallow clones of the projects Bedrock learns from. It is **gitignored** and
**read-only**: never commit it, never import from it at runtime, never copy large chunks of code.

```sh
scripts/fetch-refs.sh              # clone/update everything
scripts/fetch-refs.sh pi codex     # just these two
```

## What to read where

Bedrock is built *on* pi, so pi is the source of truth for APIs; the others are sources of ideas.

### refs/pi — the base (MIT)

| You need | Look at |
| --- | --- |
| Agent loop, tools, events | `packages/agent/src/{agent,agent-loop,types}.ts` |
| Provider API, models, faux provider | `packages/ai/src/{models,types}.ts`, `packages/ai/src/providers/faux.ts` |
| TUI components, rendering, keys | `packages/tui/src/{tui.ts,components/}`, `packages/tui/README.md` |
| Coding-agent SDK, session format, RPC | `packages/coding-agent/src/` |
| Repo conventions (pinned deps, checks) | `AGENTS.md`, `package.json` scripts |

URLs: `@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui` on npm (pin the version in our
`package.json`). Read the `.d.ts` in `node_modules` for the exact installed surface.

### refs/oh-my-pi — batteries-included pi fork (MIT)

| Subsystem | Look at |
| --- | --- |
| Hashline edits (format, stale anchors) | search for `hashline`, the read/edit tools and the prompt fragment describing anchors |
| Subagents in worktrees | `task`/`agent` tool implementation and worktree helpers |
| Advisor model | search `advisor` |
| Model roles and fallbacks | config schema and model resolution |
| Richer TUI | its fork of `pi-tui` under its packages, plus tool-card rendering |
| LSP/DAP | the `lsp`/`dap` tools |

### refs/prime-agent — RLM kernel and durability (check LICENSE)

| Subsystem | Look at |
| --- | --- |
| Persistent kernel bridge | the runtime that talks to IPython/Jupyter |
| Async `rlm()` sub-agents | kernel-side helpers and host-side handles |
| Daemon + recovery | session ownership, snapshots, heartbeats |
| Goals and gates | autonomous run loop and `goal.complete` semantics |

### refs/codex — production harness (Apache-2.0)

| Subsystem | Look at |
| --- | --- |
| Sandbox policies (Seatbelt/Landlock) | `codex-rs/` sandbox crates and their `.sbpl` |
| Approval modes | approval policy enum and "safe command" classification |
| apply_patch grammar | the patch parser and the tool description in the prompt |
| Prompts | the base instructions markdown files |
| Compaction | auto-compact prompt and thresholds |
| AGENTS.md discovery | hierarchy and size limits |

Others: `refs/terminal-bench` (task format for `lab`), `refs/ace` (playbook roles),
`refs/impossiblebench` (reward hacking evals), `refs/camel` (prompt-injection defense),
`refs/moatless-tree-search` and `refs/dgm` (search/archive ideas),
`refs/swe-agent` and `refs/openhands` (ACI and event-stream design).

## Rules

1. **Read, then write your own.** Understand the mechanism, close the file, implement it in Bedrock's
   own style and types. Do not copy blocks of code.
2. **Small, non-trivial adaptations get attribution**: a one-line comment naming the source file and
   license, plus an entry in `NOTICE.md`. Trivial ideas (a tool description, a CLI flag name) do not.
3. **Never depend on refs/ at runtime** and never add them as git submodules.
4. **Verify licenses before adapting code.** All listed refs are permissive, but check the LICENSE
   file in the clone; if it is not MIT/Apache-2.0/BSD, do not adapt code, only read for ideas.
5. If a repo moved or a URL 404s, search for the canonical location, then update
   `scripts/fetch-refs.sh` and `docs/refs.md` in the same commit.

## Studying efficiently

- Start with the package's `README.md`, then the tool/prompt definitions, then the implementation.
- `rg -n "toolDescription|description:" <dir> | head` finds prompt fragments fast.
- When comparing to pi, diff the same file path if the fork kept the layout:
  `diff -u refs/pi/packages/agent/src/agent.ts refs/oh-my-pi/packages/agent/src/agent.ts`.
- Write your findings into the relevant `docs/` page as you go; the next agent will need them.
