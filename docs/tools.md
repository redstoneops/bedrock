# Tools

Code: `packages/tools/src/` (generic tools) and `packages/core/src/tools.ts` (gate- and kernel-aware tools).

| Tool | File | Notes |
| --- | --- | --- |
| `read` | `files.ts` | numbered lines under a `¶path#TAG` header; windows via offset/limit; tag covers the whole file |
| `write` | `files.ts` | new files need no tag; replacing a file requires its current tag |
| `edit` | `files.ts`, `hashline.ts` | hashline patches (`PUT`, `CUT`, `INS.PRE/POST`) against original line numbers; stale tag rejects the whole patch |
| `str_replace` | `patch.ts` | one exact, unique occurrence |
| `apply_patch` | `patch.ts` | Codex grammar; exact, then trailing-whitespace, then whitespace-insensitive hunk matching |
| `artifact` | `artifact-tool.ts` | page or grep a stored output by `art_…` handle |
| `grep` / `find` / `ls` | `search.ts` | ripgrep when installed, built-in walker otherwise; skip build dirs |
| `bash` | `bash.ts` | sandboxed, non-blocking, streams partial output, abortable, truncates with an artifact handle |
| `todo` / `ask` | `todo.ts` | checklist; human question (in autonomous runs the answer is "no human available") |
| `ledger` / `finish` | `ledger-tool.ts` | facts/hypotheses/decisions/risks/questions; the worker's final claim |
| `checks` | `core/tools.ts` | visible gate checks; each run is an evidence entry bound to a tree hash |
| `python` | `core/tools.ts` | persistent kernel (`loop.kernel: true` or `--kernel`) |

Edit format: `edits.default` in config picks one of `hashline`, `str_replace`, `patch`; `createTools` exposes
only that one so the model does not juggle formats. Choose per model family from lab results.

Every bash call also becomes a ledger evidence entry (command, exit code, output hash) written by the mission
loop, not by the model.

`describeToolCall` (`describe.ts`) renders the one-line labels shown on TUI tool cards.

See the `adding-a-tool` skill for the checklist.
