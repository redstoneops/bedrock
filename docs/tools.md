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
| `web_search` | `web.ts` | opt-in Brave Search titles, URLs and snippets (`--web`) |
| `web_fetch` | `web.ts` | opt-in HTTPS text, HTML source, JSON or XML for exact hosts (`--web-host`) |

## Web research

Set `BRAVE_SEARCH_API_KEY` in your environment (do not put it in a command argument, prompt, or
project config). Then run, for example:

```sh
npm run bedrock -- quick --web --web-host nodejs.org \
  "Find current Node.js documentation for AbortSignal.timeout and cite the source."
```

`--web` enables only Brave search. `--web-host` enables `web_fetch` independently and can be
repeated for multiple exact hostnames. Both flags work in Mission Control, `run`, and `quick`;
neither enables shell network access. Strict permissions require approval on each request
(without an interactive approver, the request is blocked). The search key is not passed to children.

Search queries go to Brave, and fetched URL paths and query strings go to the requested host.
Do not include secrets or private code; tool arguments may appear in session logs. Web content
is untrusted reference material, not an instruction or proof of correctness. See
[ADR-0011](adr/0011-opt-in-web-research.md) for transport limits.

Edit format: `edits.default` in config picks one of `hashline`, `str_replace`, `patch`; `createTools` exposes
only that one so the model does not juggle formats. Choose per model family from lab results.

Every bash call also becomes a ledger evidence entry (command, exit code, output hash) written by the mission
loop, not by the model.

`describeToolCall` (`describe.ts`) renders the one-line labels shown on TUI tool cards.

See the `adding-a-tool` skill for the checklist.
