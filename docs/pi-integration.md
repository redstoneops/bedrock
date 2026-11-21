# pi APIs Bedrock relies on

Pinned at 1.5.2 (ADR-0001). Update this list when moving versions.

| Package | Symbols | Used in |
| --- | --- | --- |
| `@earendil-works/pi-ai` | `createModels`, `Models.completeSimple/streamSimple/getModel/getModels`, `calculateCost`, types (`Model`, `Context`, `AssistantMessage`, `SimpleStreamOptions`, `JsonValue`) | `ai` |
| `@earendil-works/pi-ai` | `fauxProvider`, `fauxAssistantMessage`, `fauxToolCall`, `fauxText` | tests, `cli/scripted.ts` |
| `@earendil-works/pi-ai/providers/all` | `builtinModels` (the full catalog with every provider) | `cli` |
| `@earendil-works/pi-agent-core` | `Agent` (`prompt`, `steer`, `abort`, `subscribe`, `finishTurn`, `afterToolCall`, `transformContext`), `AgentTool`, `AgentToolParams`, `AgentToolResult`, `AgentEvent`, `AgentMessage` | `core`, `tools` |
| `@earendil-works/pi-schema` | `obj`, `str`, `int`, `bool`, `arr`, `opt`, `oneOf` | `tools`, `core/tools.ts` |
| `@earendil-works/pi-tui` | `TuiMainScreen`, `Editor`, `Markdown`, `ProcessTerminal`, `Terminal`, `matchesKey`, `truncateToWidth`, `visibleWidth` | `tui` |

Notes:

- `createModels()` alone is empty; use `builtinModels()` for real providers.
- Tool `execute` receives `(toolCallId, params, signal, onUpdate)`; `onUpdate` drives streaming cards.
- `finishTurn` may be async and return `{ action: "end" }` to stop a worker; Bedrock uses it for turn caps,
  stall/loop stops and the advisor.
- `AgentToolResult.details` must be JSON (`toDetails` in `tools/types.ts` narrows at the boundary).
