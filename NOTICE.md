# Notice

Bedrock is MIT licensed (see `LICENSE`). It depends on pi's published packages and builds on their
APIs. It also adapts **ideas** from the projects below. No code is copied from the reference
repositories; where an implementation closely follows a specific design, the source file and license
are cited in a comment at the point of adaptation.

## Direct dependencies

| Project | License | Use |
| --- | --- | --- |
| [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-tui`, `pi-schema`) | MIT | Agent loop, provider/streaming API, tool schemas, terminal UI primitives |
| [Biome](https://biomejs.dev) | MIT | Lint and format |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | Compiler |
| [Vitest](https://vitest.dev) | MIT | Test runner |
| [diff](https://github.com/kpdecker/jsdiff) | BSD-3-Clause | Unified diff parsing and application |
| [YAML](https://github.com/eemeli/yaml) | ISC | Config parsing |
| [husky](https://github.com/typicode/husky) | MIT | Git hooks |

## Ideas adapted (no code copied)

| Project | License | Ideas |
| --- | --- | --- |
| [oh-my-pi](https://github.com/can1357/oh-my-pi) | MIT | Hashline edit anchors with stale-anchor rejection; advisor notes tagged aside/concern/blocker; subagents in isolated git worktrees returning schema-validated results; model roles and fallback chains; TUI tool cards |
| [Prime Intellect prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) | see upstream | Persistent kernel as the primary tool; async `rlm()` sub-agents with handles and messaging; Continual Harness state with `/refine` and rollback; daemon-owned sessions with crash recovery; goal + gate autonomous runs |
| [OpenAI Codex](https://github.com/openai/codex) | Apache-2.0 | Sandbox modes (read-only / workspace-write / full access) and Seatbelt/Landlock wrapping; approval policies and safe-command classification; `apply_patch` grammar; long-running-agent instructions on planning, persistence and verification; auto-compaction; AGENTS.md discovery |
| [ACE](https://github.com/ace-agent/ace) | see upstream | Generator/Reflector/Curator playbook with incremental deltas rather than rewrites |
| [Terminal-Bench](https://github.com/laude-institute/terminal-bench) | Apache-2.0 | Task and harness format used by the lab adapter |
| [ImpossibleBench](https://github.com/safety-research/impossiblebench) | see upstream | Cheat-rate evaluation of reward hacking |
| [CaMeL](https://github.com/google-research/camel-prompt-injection) | see upstream | Dual-LLM pattern and capability tagging against prompt injection |
| [Meta-Harness](https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact) | see upstream | Filesystem-of-traces outer loop for harness optimization |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | MIT | Agent-computer interface design lessons |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | MIT | Event-stream architecture and microagents |
| [SWE-Search / moatless-tree-search](https://github.com/aorwall/moatless-tree-search) | see upstream | MCTS over agent trajectories |
| [Darwin Gödel Machine](https://github.com/jennyzzt/dgm) | see upstream | Diverse archive of self-modifying variants |

If you believe an adaptation is missing here, that is a bug: add the row and the citation comment.
