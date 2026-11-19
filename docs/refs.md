# Reference repositories

`refs/` is gitignored. `scripts/fetch-refs.sh` shallow-clones and updates it. These repos are
**read-only learning material**: nothing here is imported at runtime and no large chunks are copied.
See the `studying-refs` skill for how to use them and the attribution rules.

| Name | Repository | License | What Bedrock takes from it |
| --- | --- | --- | --- |
| `pi` | https://github.com/earendil-works/pi | MIT | **The base.** We depend on `pi-ai`, `pi-agent-core`, `pi-tui`. Agent loop, provider abstraction, differential rendering, faux provider for tests. |
| `oh-my-pi` | https://github.com/can1357/oh-my-pi | MIT | Hashline edits, subagents in worktrees with schema-validated results, advisor notes (`aside`/`concern`/`blocker`), model roles and fallbacks, richer TUI cards, LSP/DAP tooling, metaharness runner. |
| `prime-agent` | https://github.com/PrimeIntellect-ai/prime-agent | see repo | Persistent IPython kernel as the main tool, async `rlm()` sub-agents with messaging, Continual Harness state with `/refine` and rollback, daemon + crash recovery, goal + gate autonomous runs, documented reward hacking from self-refinement. |
| `codex` | https://github.com/openai/codex | Apache-2.0 | Seatbelt/Landlock sandbox policies and modes, approval policies and safe-command classification, `apply_patch` grammar, base prompts (persistence, planning, verification), auto-compaction, exec-mode JSON events, AGENTS.md discovery. |
| `opencode` | https://github.com/anomalyco/opencode | MIT | Comparison point for a mature open TUI agent; client/server split. |
| `ace` | https://github.com/ace-agent/ace | see repo | Generator/Reflector/Curator playbook with incremental deltas instead of rewrites. |
| `swe-agent` | https://github.com/SWE-agent/SWE-agent | MIT | Agent-computer interface design; trajectory tooling. |
| `openhands` | https://github.com/All-Hands-AI/OpenHands | MIT | Event-stream architecture, runtime sandboxes, microagents. |
| `terminal-bench` | https://github.com/laude-institute/terminal-bench | Apache-2.0 | Task format and harness semantics for the `lab` adapter. |
| `kira` | https://github.com/krafton-ai/KIRA | see repo | Minimal harness changes with outsized Terminal-Bench gains. |
| `meta-harness` | https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact | see repo | Outer-loop harness optimization: proposer reads code, scores and full traces from a filesystem. |
| `impossiblebench` | https://github.com/safety-research/impossiblebench | see repo | Measuring reward hacking (cheat rate) for the integrity suite. |
| `camel` | https://github.com/google-research/camel-prompt-injection | see repo | Dual-LLM + capability tags against prompt injection. |
| `moatless-tree-search` | https://github.com/aorwall/moatless-tree-search | see repo | MCTS over agent trajectories. |
| `dgm` | https://github.com/jennyzzt/dgm | see repo | Self-modifying agent archive, for the Anvil variant archive. |

## Reading order for a new contributor

1. `refs/pi/packages/agent/src/types.ts` — the loop contract we build on.
2. `refs/pi/packages/ai/src/providers/faux.ts` — how to test agents without API keys.
3. `refs/oh-my-pi` — search for `hashline`, `advisor`, `worktree` before designing our versions.
4. `refs/codex/codex-rs` — sandbox policy and `apply_patch` before designing ours.
5. `refs/prime-agent` — kernel and daemon before designing ours.

## Adding a reference

Add it to `scripts/fetch-refs.sh`, this table (with license), and say in an ADR why it matters.
