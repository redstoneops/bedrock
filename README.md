# Bedrock

**Agents that stand on verified ground.**

Bedrock is a terminal coding-agent harness for extremely hard, long-horizon tasks — multi-day refactors,
paper reimplementations, distributed-systems debugging, ports, performance work, Terminal-Bench-class
tasks. It optimizes for **success rate first**, cost second, latency third.

> Nothing is done until it is verified, with evidence, by someone who didn't do the work.

## Why

Harness design changes outcomes as much as model choice does. On the same benchmark, the same model
swings 15–20+ points depending on the harness around it. Most harnesses are built for interactive
pair programming, where "done" means "the model stopped talking". Bedrock is built for tasks where
being right matters more than being fast, and where false completion is the worst failure mode.

## The premise

Every claim the agent makes about the world — *the bug is in X*, *the tests pass*, *the task is done* —
must be backed by evidence the harness can check. So Bedrock:

1. **Verifies first.** The task is compiled into a *Gate* (checks, invariants, rubric, hidden holdout)
   before any solution is written. "Done" means the gate passes, not that the model says so.
2. **Keeps a Ledger.** Facts, hypotheses, decisions, risks and the evidence behind each one, queryable
   out of the prompt. Claims without evidence get flagged.
3. **Treats context as a variable.** History, files and logs live in an event log and a persistent
   kernel; the prompt holds a *view* of state, not the whole transcript.
4. **Spends compute where uncertainty is.** A budget controller chooses between continuing, refining,
   branching to a different approach, widening to parallel workers, or escalating models.
5. **Is durable.** Event-sourced sessions, checkpoints, crash recovery — a hard task can survive a
   `kill -9` hours in.
6. **Compounds carefully.** Lessons become versioned playbook deltas, checked against held-out evals
   and rollback-able, never silent self-modification.
7. **Is nice to live in.** A Mission Control TUI for watching, steering and auditing long runs.

## Building on pi

Bedrock does not rewrite pi. It depends on pi's published packages for the agent loop, providers and
TUI ([ADR-0001](docs/adr/0001-build-on-pi.md)):

- [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) — unified providers
- [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) — agent loop
- [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) — differential-rendering TUI

Ideas are studied from [oh-my-pi](https://github.com/can1357/oh-my-pi),
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) and
[codex](https://github.com/openai/codex) — see [docs/refs.md](docs/refs.md). No code is imported from
them.

## Quick start

```sh
npm install
npm run bedrock                     # Mission Control: Ctrl+P opens the command picker
npm run bedrock -- run --goal "make the failing tests pass" --gate "npm test"
npm run bedrock -- quick "rename foo to bar in src/"
npm run bedrock -- lab run          # smoke suite with an independent holdout evaluator
```

On first launch, use `/login` to pick a provider and sign in. Select a configured model with
`/model`. `/goal <task>` starts a verified mission; `/plan <task>` previews the local workflow
without calling a model. For non-interactive runs, use a stored login or the provider's API-key
environment variable. For another repository, run `node /path/to/bedrock/packages/cli/bin/bedrock.js`
from that repository's root.

Install a local `SKILL.md` with `npm run bedrock -- skills add ./path/to/skill`. Pick it with
`/skill` or pass `--skill <name>` to `run` or `quick`. Installing a skill does not activate it.

What happens on `run`: the repo is scouted, a gate is compiled from its own test/build/lint commands plus
your `--gate`, one worker attacks it in an isolated git worktree, an independent verifier runs the gate (and
any holdout), and only a verified result is applied to your checkout. If the first attempt fails, the budget
policy refines, branches to a different approach, or widens to parallel workers with distinct strategies.
Every mission ends with `.bedrock/missions/<id>/proof.md`.

Requirements: Node >= 22.19 (developed on Node 26), npm.

## Layout

| Package | What it owns |
| --- | --- |
| `@bedrock/protocol` | Shared domain types and event schema |
| `@bedrock/ai` | Model roles, routing, fallbacks, cost |
| `@bedrock/ledger` | Evidence ledger (SQLite) |
| `@bedrock/context` | Event log, artifacts, compaction, prompt assembly (Hopper) |
| `@bedrock/tools` | hashline edits, read/write/patch, grep/find, bash, todo, ask |
| `@bedrock/sandbox` | Permissions, command safety, OS sandboxes, redaction, audit (Obsidian) |
| `@bedrock/isolation` | Worktrees, copies, checkpoints, rewind |
| `@bedrock/gate` | Gate compiler, check runner, holdout, integrity (Recipe) |
| `@bedrock/verify` | Verifier stack L0–L4, final state, selection (Observer, Comparator) |
| `@bedrock/kernel` | Persistent Python kernel: context as a variable |
| `@bedrock/memory` | Task state, playbook, guarded refinement (Chest, Bookshelf) |
| `@bedrock/core` | Mission loop, budget controller, workers, advisor (Crafter, Repeater, Pistons) |
| `@bedrock/daemon` | Session ownership, attach/detach, recovery |
| `@bedrock/tui` | Mission Control |
| `@bedrock/lab` | Benchmarks, ablations, meta-harness (Beacon, Anvil) |
| `@bedrock/cli` | `bedrock` / `br` |

## Docs

- [Architecture](docs/architecture.md) · [The loop](docs/loop.md) · [Gates](docs/gate.md) · [Verification](docs/verification.md) · [Context & ledger](docs/context.md) · [TUI](docs/tui.md) · [Lab](docs/lab.md)
- [Configuration](docs/configuration.md) · [Integrity & security](docs/security.md) · [Reference repos](docs/refs.md) · [Progress](docs/progress.md)
- [ADRs](docs/adr/) · [Product requirements](PRD.md)
- Building agents should start at [AGENTS.md](AGENTS.md) and `.agents/skills/`.

MIT licensed. See [NOTICE.md](NOTICE.md) for ideas adapted from other projects.
