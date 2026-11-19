# Bedrock — Product Requirements

Status: v0.1, consolidated working spec. Audience: the coding agents that build and maintain this repo.

> **Bedrock: agents that stand on verified ground.**
> A terminal coding agent harness built for extremely hard, long-horizon tasks, where being right
> matters more than being fast.

This document merges two input drafts. Their originals are preserved verbatim:
[draft A](docs/prd/draft-a.md) (research and loop design) and [draft B](docs/prd/draft-b.md)
(components, tiers, integrity). Where they disagreed, this document decides:
[ADR-0004](docs/adr/0004-one-spec-functional-names.md) explains every resolution.

---

## 0. Instructions to the implementing agent

1. **Work in `./`.** The repo root is the monorepo root. Do not create a nested project folder.
2. **Build on pi, don't rewrite it.** Depend on `@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui`
   (see [ADR-0001](docs/adr/0001-build-on-pi.md)). Fork only with an ADR.
3. **Make atomic commits.** Conventional Commits; every commit passes `npm run check` and `npm test`.
4. **Study the reference repos first.** They are cloned into `refs/` (gitignored) by
   `scripts/fetch-refs.sh`. Read them, never import them, cite non-trivial adaptations.
5. **Record decisions** in `docs/adr/NNNN-title.md`. When this PRD is ambiguous, pick the simplest
   option that keeps the door open, write an ADR, move on.
6. **Keep the repo agent-friendly.** Update `AGENTS.md`, `.agents/skills/`, and `docs/` in the same
   change as the code they describe.
7. **Measure.** A harness feature is not done until `@bedrock/lab` shows it helps, or the claim is
   marked unverified.

---

## 1. Problem

Harness design changes outcomes as much as model choice does. With the same model, Terminal-Bench 2.0
scores swing 15–20+ points depending on the harness; Meta-Harness measures up to a 6x gap. Most
harnesses are built for interactive pair programming, where the human verifies and "done" means the
model stopped talking. On hard tasks (multi-day refactors, paper reimplementation, distributed-systems
debugging, ports, performance work, Terminal-Bench-class tasks) that design fails predictably:

| Failure mode | What it looks like |
| --- | --- |
| False completion | The agent declares success without evidence, sometimes after weakening the check |
| Context rot | Compaction loses the exact detail the task needed; the agent repeats or contradicts itself |
| Tunnel vision | One approach is committed to early and never revisited |
| Unverified claims | "Tests pass" when they were never run, or run against the wrong tree |
| Reward hacking | The check is gamed: tests edited, inputs special-cased, history mined, gate weakened |
| Fragility | A crash, OOM or network blip loses hours of progress |
| No compounding | Lessons from run N are gone by run N+1 |

Bedrock exists to fix these. It is optimized for **success rate on hard tasks, then cost, then
latency**, in that order.

---

## 2. Premise and pillars

> **Nothing is done until it is verified, with evidence, by someone who didn't do the work.**

1. **Verify first, then solve.** Turn the task into a *Gate*: acceptance checks, invariants, rubric,
   and a hidden holdout, compiled before the solution. "Done" means the gate passes.
2. **Evidence over assertion.** A structured Ledger holds facts, hypotheses, decisions and risks with
   the evidence behind each. Claims without evidence are flagged.
3. **Adaptive test-time compute.** One attempt for easy tasks; best-of-N, tree search or evolutionary
   search for hard ones, always selected by verifiers, always under a budget.
4. **Context is a variable, not a transcript.** History, files, logs and sub-results live in an event
   log, an artifact store and a persistent kernel. The prompt holds a view of state.
5. **Diversity beats persistence.** When stuck, branch to a different approach in an isolated
   worktree rather than retrying the same thing.
6. **Durable by default.** Event-sourced sessions, checkpoints, crash recovery. A hard task can run
   for hours or days and survive restarts.
7. **Security-native integrity.** Sandboxed execution, egress allowlists, an audit log, dual-LLM
   handling of untrusted content, and diff monitoring for spec gaming.
8. **Compound, but guarded.** Playbook lessons are versioned, attributed, rollback-able deltas that
   pass held-out evals before they change verification behavior.
9. **A TUI people want to live in.** A cockpit for watching, steering and auditing without breaking
   the loop.
10. **Measured, not vibes.** Every feature ships with an eval; the harness itself is optimized offline.

### Non-goals (v1)

- Being the fastest agent for one-line edits. There is a `quick` mode, but it is not the focus.
- An IDE plugin or web UI. Both come later through the RPC/SDK.
- Training models. Bedrock produces trajectories; it does not train.
- A built-in OS sandbox. Following pi and codex, Bedrock ships sandbox *wrapping* and recommends
  containers, not a kernel sandbox of its own.

---

## 3. Product shape

| Mode | Use | Loop |
| --- | --- | --- |
| `bedrock` (interactive) | Human in the loop in the TUI | Full loop, asks when useful |
| `bedrock run --goal "..." [--gate "cmd"]` | Autonomous hard task | Full loop until the gate passes or the budget ends |
| `bedrock quick` | Small edits | Plain ReAct loop on pi-agent-core, no ceremony |
| `bedrock -p` / `--json` | Scripting, CI | Headless, JSONL event stream |
| `bedrock rpc` / SDK | Embedding (IDE, web, evals) | JSON-RPC over stdio or socket |
| `bedrock lab ...` | Evals, harness optimization | Benchmark runner plus meta-harness loop |

### The user's mental model

1. Give Bedrock a **Mission** (goal, optional gate commands, budget).
2. It **scouts** the repo and environment, then proposes a **Gate**; in interactive mode you edit it.
3. It **plans** a strategy tree, then **executes** with one or more workers, **verifies**,
   **selects**, and **reflects**.
4. You watch in **Mission Control**: strategy tree, workers, ledger, gate status, budget. You can
   steer at any time.
5. It ends with a **Proof of Work**: the diff, gate results including holdout, evidence links,
   cost, and the risks and unverified claims that remain.

---

## 4. The loop

```
MISSION (goal · constraints · budget · optional gate commands)
   │
   ├─ BOOTSTRAP   snapshot environment, worktree, base tree hash
   ├─ SCOUT       repo map, build/test commands, context files, services
   ├─ GATE        compile checks + invariants + rubric + holdout; validate acceptance checks
   ├─ PLAN        strategy tree of distinct approaches + budget plan
   ├─ EXECUTE     N workers, each a pi Agent in its own worktree (+ kernel), advisor watching
   ├─ VERIFY      L0 static → L1 targeted → L2 full gate + holdout → L3 rubric/SRC → L4 red team
   ├─ DECIDE      pass → select/merge; partial → refine; stuck → branch; budget → stop honestly
   └─ REFLECT     playbook deltas (guarded, versioned, held-out checked)
Everything is appended to the EVENT LOG and the LEDGER, owned by the DAEMON.
```

**Phases and who owns them**

| Phase | Owner | Output |
| --- | --- | --- |
| Bootstrap | `core` + `isolation` | base tree hash, worktree, env snapshot |
| Scout | `core/scout` (role `scout`, cheap model) | `ScoutReport` |
| Gate | `gate/compiler` (roles `strategist`/`verifier`) | `Gate` v1, approved or user-edited |
| Plan | `core/strategist` | `StrategyTree` |
| Execute | `core/worker` per branch | candidate commits, ledger entries, events |
| Verify | `verify/stack` | `GateResult` bound to tree hash |
| Decide | `core/budget-policy` + `verify/select` | next action, winner |
| Reflect | `memory/playbook` | versioned deltas |

---

## 5. Test-time compute: tiers and the budget controller

Draft B's tiers are the strategy layer; Draft A's budget actions are the control layer. The mapping:

| Tier | Strategy | Entered when |
| --- | --- | --- |
| 0 | Single trajectory + verify loop | default for easy/medium tasks |
| 1 | Parallel best-of-N in worktrees + Comparator | tier 0 failed, or difficulty is medium/high |
| 2 | Tree search over git checkpoints with a value function | long task with clear decision points |
| 3 | Evolutionary search with a diverse archive | optimization task with a numeric score |

The **budget controller** is a pure function from `BudgetSignals` to one action:

- Signals: gate pass ratio and trend, verifier disagreement, turns since a new ledger fact ("stall"),
  repeated-action ratio, candidate count and diversity, advisor blockers, cost/tokens/wall clock.
- Actions: `continue`, `refine` (distill failures, restart), `branch` (new strategy), `widen` (more
  parallel workers), `escalate` (stronger model or effort), `prune` (kill weak branches early),
  `ask_human` (interactive), `stop`.
- Defaults: start with one worker; widen to ≤4 after a full failing attempt on a hard task; escalate
  before widening when verifiers disagree (ambiguity, not difficulty); a stall of K turns triggers a
  reflection turn, then a branch; cap sequential turns near 100–140 (SWE-Lego saturation) and prefer
  parallel or distilled restarts after that.
- Hard limits (turns, tokens, cost, wall clock, parallelism) are enforced by the harness. Out of
  budget means the best candidate plus an honest `partial`/`exhausted` report, never a fake pass.

The policy is an interface (`BudgetPolicy`) so the lab can evolve it and prove improvements.

---

## 6. Verification

### 6.1 The Gate (compiled before solving)

- `checks`: commands with expected outcomes — build, lint, type-check, tests, benchmarks with
  thresholds, runtime checks.
- `invariants`: what must not change — public API, unrelated tests, perf budgets, protected files.
- `rubric`: repo-grounded criteria for qualities that cannot be executed.
- `holdout`: checks hidden from workers, run only by the verifier and the final report.
- `integrity`: protected paths, justification-required paths, history-mining and network rules.
- Acceptance checks must **fail on the pre-fix tree** (or be justified as non-regression), so they
  actually test something. The compiler runs them against the base tree to prove it.
- User-supplied `--gate` commands are always included and cannot be weakened.

### 6.2 Layers, cheapest first

| Layer | What | Cost |
| --- | --- | --- |
| L0 | static: LSP diagnostics, typecheck, lint, hashline integrity, protected-path check | ms–s |
| L1 | targeted tests and the worker's own acceptance tests | s–min |
| L2 | full gate: visible checks, invariants, and the hidden holdout | min |
| L3 | generative verifier: rubric scoring plus SRC-style comparison across candidates | tokens |
| L4 | adversarial red team in a fresh context trying to break the solution or expose a gamed gate | tokens |

Every result is evidence entry bound to a **tree hash** and commit, not to a message.

### 6.3 Selection and refinement

- If several candidates pass, rank them with **Recursive Tournament Voting** over compact summaries
  plus diffs; tie-break on smaller diff, fewer invariant risks, better rubric score. Merging
  complementary partials is allowed and creates a new candidate that must pass the gate again.
- For partial passes, **Parallel-Distill-Refine**: distill failing checks, ruled-out hypotheses and
  useful sub-results into a brief, then start fresh rollouts conditioned on it. Never keep extending
  a dead context.

### 6.4 Final state

The harness computes `passed | partial | failed | unverified | cancelled | exhausted`. Only `passed`
with a clean holdout and integrity report counts as success. Everything else is reported with the
reason.

---

## 7. Integrity and security

- **Gate integrity:** workers cannot modify gate files or holdout material. Test-file changes are
  flagged and require a ledger justification; the L4 red team reviews them.
- **Diff monitor** flags: test edits without justification, skipped/disabled tests, special-cased
  test inputs, reads of evaluation files, history mining when forbidden, unexpected network use,
  monkey-patching time or stdlib, and hardcoded expected output.
- **Sandboxing:** permission presets `yolo | standard | strict`; default `standard` interactively and
  `yolo` autonomously *only inside a worktree or container*. On macOS, commands are wrapped with
  Seatbelt (`sandbox-exec`) profiles; on Linux, Landlock/seccomp or bubblewrap when available; the
  important fallback is `--container` (Docker/Podman) with default-deny network plus an allowlist.
- **Secrets:** known patterns are redacted from logs and the ledger; `.env` contents never reach the
  advisor or red team unless explicitly needed; secrets are injected at execution time.
- **Prompt injection:** untrusted content (web, issues, tool output from outside the repo) is handled
  by a quarantined model with no tool access; data carries provenance and capability tags, and policy
  blocks forbidden flows.
- **Audit:** every tool call, permission decision, gate result and final state is in the append-only
  event log and audit log.
- **Supply chain:** exact dependency pins, `--ignore-scripts` installs, lockfile committed, a minimum
  release age for non-pi packages.

---

## 8. Context, kernel, memory

- **Event log:** append-only JSONL per session; branching moves a leaf; everything replays.
- **Ledger:** typed records in SQLite (`facts`, `hypotheses` with open/confirmed/refuted, `decisions`,
  `evidence` with command, exit code, output hash and tree hash, `risks`, `questions`, `artifacts`,
  `checkpoints`, `candidates`).
- **Artifacts:** large outputs are content-addressed files; prompts get heads, tails and matches with
  an explicit truncation note.
- **Prompt assembly:** system prompt + mission + gate summary + ledger slice + strategy + recent turns
  + retrieved playbook entries, ordered stably for provider prompt caching.
- **Compaction never deletes:** a summary plus pointers; raw history stays queryable
  (`history.search`, `history.turn`).
- **Kernel:** a persistent Python REPL where tools, the ledger, history and `spawn()` are importable,
  so a 50 MB log can be sliced and fanned out without entering the prompt (see §10).
- **Chest:** on-disk task state — `recipe.json`, `plan.md`, `progress.md`, `decisions.md`,
  `failures.md` — plus git checkpoints, so a fresh context can bootstrap in seconds.
- **Bookshelf / playbook:** small itemized lessons with scope, trigger, helpful/harmful counters,
  updated by incremental deltas (add, merge, deprecate), retrieved by scope and trigger.

---

## 9. Multi-agent

- `spawn(role, brief, schema?)` is async and returns a handle; results are schema-validated.
- Messaging is limited to parent, children and siblings; named agents persist and can be messaged
  later; idle agents unload and reload from disk.
- Roles: `scout`, `strategist`, `worker`, `advisor`, `verifier`, `judge`, `red_team`, `reflector`,
  `curator`, `commit`, `smol`. Each maps to a model and effort in config.
- Heterogeneous verification by default: verifier, judge and red team prefer a different model family
  from the worker when one is available, to decorrelate blind spots.

---

## 10. Execution substrate

Two complementary surfaces, both enabled by default:

1. **First-class tools** for high-frequency actions with structured TUI rendering: `read`, `write`,
   `edit` (hashline), `apply_patch`, `ast_edit`, `grep`, `find`, `bash` (PTY, timeouts, background
   jobs), `lsp`, `todo`, `ask`, `task`/`spawn`, `ledger`, `web_search`, `fetch`.
2. **A persistent kernel** for programmatic work: Python where tools, the ledger, history and
   `spawn()` are importable. This is where context-as-variable lives.

Edits: **hashline** by default — reads tag lines with short content hashes; edits reference anchors;
stale anchors are rejected before anything is applied. `str_replace` and `apply_patch` are fallbacks,
chosen per model family from lab results. All edits are atomic per call, recorded, and rewindable.

Isolation: one git worktree per worker (reflink/overlay copy for non-git dirs), checkpoints at
verified milestones, `/rewind` to any checkpoint, optional `--container <image>`.

---

## 11. Durability

- `bedrockd` owns sessions over a local socket; the TUI and CLI attach and detach freely.
- Each mission runs in a recoverable process. After a crash it restores from the event log, the
  ledger and the last kernel/checkpoint snapshot, then continues.
- Heartbeats and goals persist until the gate passes; hard limits are enforced by the daemon.
- Injection faults (SIGKILL, OOM, blocked network) are part of the lab's recovery metric.

---

## 12. TUI — Mission Control

Built on `@earendil-works/pi-tui`, differential rendering, 60 fps streaming, no full redraws.

Default layout (collapsible panes): header with mission, cost/budget and elapsed time; strategy tree
(left, with status per branch); conversation/active-worker cards with tool cards and advisor notes
(center); gate status with check list and holdout lock (left bottom); ledger strip; steering input.

Required views: Agent Hub (every worker/sub-agent, status, cost, last action, transcript, steer,
pause, kill, revive), Ledger (filterable, jump from claim to evidence), Gate (live status, rerun one
check, diff gate versions), Diff (per-candidate, side-by-side), Tree/timeline (branch and rewind),
Proof of Work screen. Interactions: steering queued at turn boundaries, `Esc` interrupts,
`Ctrl+K` command palette, `/` commands, `@file` fuzzy picker, model/role switcher. 80x24 to wide,
truecolor with 256-color fallback, SSH/tmux friendly, Kitty/iTerm2 images where available, pi themes.

Quality bar: no flicker, keyboard-first, and a user who has tried pi/oh-my-pi finds it at least as
pleasant.

---

## 13. Repo layout

```
.
├── AGENTS.md                  entry point for agents
├── CLAUDE.md                  pointer to AGENTS.md
├── PRD.md                     this document
├── NOTICE.md                  attributions
├── package.json  package-lock.json  tsconfig*.json  biome.json  vitest.config.ts
├── .agents/skills/<name>/SKILL.md
├── docs/{architecture,loop,gate,ledger,verification,context,tools,security,isolation,
│         kernel,memory,daemon,tui,lab,configuration,refs,progress}.md
├── docs/adr/NNNN-*.md
├── docs/prd/{draft-a,draft-b}.md
├── scripts/fetch-refs.sh  scripts/build.mjs
├── refs/                      gitignored reference repos
├── packages/
│   ├── protocol/  ai/  ledger/  context/  sandbox/  isolation/  tools/
│   ├── gate/  verify/  kernel/  memory/  core/  daemon/  tui/  lab/  cli/
└── evals/
    └── bedrock-hard/          curated hard tasks + gates
```

Stack: Node >= 22.19, npm workspaces, TypeScript 7 strict ESM (`erasableSyntaxOnly`), Biome 2,
Vitest 4, SQLite via `node:sqlite`, JSONL event logs, YAML config, husky pre-commit, GitHub Actions.

Package rules: `protocol` has no runtime deps; dependencies point downward only; every package has
`src/index.ts` (the only entry), tests in `test/`, and a README. See `docs/architecture.md`.

---

## 14. Agent-facing developer experience

`AGENTS.md` is the entry point; `.agents/skills/` teaches each subsystem. Required skills:
`repo-overview`, `dev-workflow`, `atomic-commits`, `studying-refs`, `adding-a-package`,
`adding-a-tool`, `writing-a-gate`, `writing-a-verifier`, `tui-components`, `running-evals`,
`writing-adrs`. A skill that is out of date is a bug fixed in the same change.

Success criterion for v1: a new contributor agent, using only `AGENTS.md` and the skills, can add a
tool with tests and docs in one session.

---

## 15. Configuration

`~/.bedrock/config.yml` (user) and `.bedrock/config.yml` (project, overrides user). Full key
reference in [docs/configuration.md](docs/configuration.md). Shape:

```yaml
roles:
  worker:   { model: anthropic/claude-opus-5-5, effort: high }
  verifier: { model: openai/gpt-5-5, effort: high, requireDifferentFamily: true }
loop:
  gateFirst: true
  maxParallelWorkers: 4
  workerTurnCap: 120
  selection: rtv        # rtv | judge | first_pass
  refine: pdr           # pdr | continue | none
  advisor: true
  redTeam: true
budget: { usd: 20, wallClockMs: 14400000 }
edits:  { default: hashline, fallback: [str_replace, patch] }
permissions: standard   # yolo | standard | strict
isolation: worktree     # worktree | copy | container
memory: { playbook: true, refineRequiresHoldout: true, sharePlaybook: false }
```

Model ids are examples; use whatever pi-ai's catalog exposes. Roles default to a strong default model
with cheap `scout`/`smol` overrides.

---

## 16. Milestones

Each milestone ends with green CI, updated docs and skills, ADRs for decisions made, and a short
entry in `docs/progress.md`.

| M | Deliverable | Exit criteria |
| --- | --- | --- |
| M0 Repo | Monorepo, tooling, CI, `.gitignore`, refs script, AGENTS.md + first four skills, ADR-0001..0004, protocol contract | `npm run check` and `npm test` pass on a clean clone |
| M1 Quick agent | `bedrock quick` on pi-agent-core + pi-ai, hashline/read/write/bash tools, minimal TUI | Fixes a simple bug end to end in the TUI |
| M2 Durable core | Event log, ledger, sandbox presets, isolation worktrees, daemon, recovery, checkpoints | `kill -9` mid-task, resume with no lost verified progress |
| M3 Gate + verify | Gate compiler, check runner, holdout, L0–L2, computed final state, diff monitor | False-completion rate measurably below quick mode on the eval set |
| M4 Mission Control | Strategy tree, gate, ledger, agent hub, diff, steering, palette, proof screen | Usable for a 1h+ mission without leaving the TUI |
| M5 Parallel + selection | Worktree workers, strategist, budget controller, RTV selection, PDR refine, advisor | Ablation shows a gain over a single worker on Bedrock-Hard |
| M6 Kernel | Persistent kernel, context as variable, `spawn()` handles and messaging | Solves long-log tasks that fail in tools-only mode |
| M7 Compounding | Playbook, harness state, guarded refinement, red team, ImpossibleBench-style cheat evals | Improvement across repeated runs with no gate gaming in the audit |
| M8 Lab + evolve | Terminal-Bench adapter, dashboard, `lab evolve` | A discovered config beats the hand-tuned default on held-out tasks |

---

## 17. Metrics

Success rate (pass@1 and Best@K), cost per solved task, wall clock, tokens, **false-completion rate**
(claimed done, holdout fails), verifier precision and recall, cheat rate on ImpossibleBench-style
tasks, recovery rate after injected faults, and Observer-human agreement on sampled tasks. The lab
reports all of them per run; ablations are mandatory for each loop component (gate-first on/off,
advisor on/off, parallel N, RTV vs a single judge, PDR vs continue, kernel vs tools-only, hashline vs
str_replace).

---

## 18. Success criteria for v1

- Terminal-Bench 2.x score with a given model above the same model in pi/oh-my-pi on at least two
  model families.
- False-completion rate under 3% on Bedrock-Hard.
- Survives injected crashes with no lost verified progress.
- A new contributor agent can add a tool with tests and docs in one session using only the repo docs.

---

## 19. Open questions

| # | Question | Current answer |
| --- | --- | --- |
| 1 | Bun or Node? | Node + npm (ADR-0002); revisit with install-time numbers |
| 2 | Depend on pi or fork? | Depend; fork only with an ADR naming the missing capability (ADR-0001) |
| 3 | Kernel language? | Python via `uv`/`python3`; Bun/JS kernel behind the same interface later |
| 4 | Gate approval in interactive mode? | Always show it; auto-approve only when the user passed `--yes-gate` |
| 5 | Default parallelism? | 1 worker, widen adaptively to ≤4 (see §5) |
| 6 | Verifier model diversity? | Required by default when another family is configured |
| 7 | Playbook storage? | Local `.bedrock/playbook` by default; opt-in commit for teams |
| 8 | Rust natives? | Only with a profile showing the hot path; grep and PTY first |
| 9 | v1 benchmarks? | Terminal-Bench primary; a small SWE-bench Verified subset from M5 |

---

## 20. Research basis

Anthropic, *Effective harnesses for long-running agents* (2025) and *Harness design for long-running
application development* (2026) · Merrill et al., Terminal-Bench (ICLR 2026) · Lee et al.,
Meta-Harness (2026) · Zhang, Kraska, Khattab, Recursive Language Models (2025) · Prime Intellect,
prime-agent (2026) · can1357, oh-my-pi (2026) · Zhang et al., ACE (ICLR 2026) · Zhong et al.,
ImpossibleBench (2025) · Zhang et al., Darwin Gödel Machine (2025) · Google DeepMind, AlphaEvolve
(2025) · Cemri et al., MAST (2025) · Debenedetti et al., CaMeL (2025) · R2E-Gym hybrid verifiers
(2025) · Multi-Agent Verification (2025) · Chroma, Context Rot (2025) · Antoniades et al., SWE-Search
(2025) · Brown et al., Large Language Monkeys (2024) · Wang et al., Voyager (2023) · SWE-Lego
(2026) · Agentic Rubrics (2026) · SWE-TRACE (2026).
