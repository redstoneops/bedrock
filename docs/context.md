# Context, ledger, memory, kernel and daemon

## Event log (`packages/context/src/event-log.ts`)

Append-only JSONL per session under `.bedrock/sessions/<session>.jsonl`. Replay tolerates a torn final line;
`rewindTo` moves the leaf without deleting; `branch` starts a new log that records its parent.

## Artifacts and truncation (`artifacts.ts`)

Content-addressed files under `.bedrock/artifacts`. `truncateOutput` keeps head and tail and states what
was dropped; the `artifact` tool reads the rest by handle.

## Prompt assembly (`prompt.ts`)

`assemblePrompt` orders stable sections first for provider cache hits. Workers use their own system prompt
(`core/worker.ts#workerSystemPrompt`) plus the brief (`core/prompts.ts`), playbook notes and repository
instructions (AGENTS.md and friends, via the scout).

## Compaction (`packages/core/src/compaction.ts`)

Observation masking: past the token budget, old tool results become one-line stubs; reasoning and calls
stay. Nothing is deleted from the record.

## Ledger (`packages/ledger/src/ledger.ts`)

SQLite (`node:sqlite`) at `.bedrock/ledger.sqlite`. Facts, hypotheses (the only mutable field is their
status), decisions, evidence, risks, questions. `summary` gives the unsupported-claim ratio; `refineBrief`
distills failures for the next round. Evidence comes from the harness: every bash call, every `checks` run,
every verification and the apply check.

## Memory (`packages/memory/src/`)

- **Chest** (`chest.ts`): `.bedrock/chest/{recipe.json,plan.md,progress.md,decisions.md,failures.md}`,
  written as the mission runs so a fresh context or a human can pick up.
- **Playbook** (`playbook.ts`): ACE-style deltas (add, merge, deprecate, feedback), versioned with rollback;
  recalled into worker prompts; the reflector proposes add-only lessons.
- **Harness state** (`harness-state.ts`): versioned refinements of prompt notes and sub-agent definitions;
  the gate, verifier, integrity rules, evals and system prompt are immutable; verification-affecting notes
  need a held-out eval pass or human approval.

## Kernel (`packages/kernel/src/kernel.ts`)

A long-lived Python process speaking JSON lines. Variables persist, a trailing expression's repr is
returned (evaluated once), helpers `read/write/ls/grep/spawn` are injected, and the namespace can be
pickled and restored. Exposed to workers as the `python` tool.

## Daemon (`packages/daemon/src/`)

`bedrockd` owns sessions over a Unix socket with newline-delimited JSON commands (status, list, attach,
detach, replay, steer, pause, resume, kill). The registry is written atomically; `recoverSessions` replays
logs and marks unfinished missions interrupted (`bedrock sessions`). Today missions run in the CLI process;
the daemon provides recovery and fan-out, and running missions inside it is planned.
