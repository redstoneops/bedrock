// @bedrock/tools: the shell tool.

import { truncateOutput } from "@bedrock/context";
import type { AgentTool, AgentToolParams, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { failure, resolveInside, runSandboxed, type ToolContext, toDetails } from "./types.ts";

const BASH_DESCRIPTION = `Run a shell command in the workspace. Returns exit code, stdout and stderr.

Rules that matter:
- Prefer read, grep and find over cat/rg/find when you can; they are cheaper and structured.
- The command runs inside the sandbox. Writes outside the workspace, network access and edits to gate material are refused.
- Long output is truncated in the middle and stored as an artifact; do not re-run a command to "see more", grep the artifact instead.
- Do not chain unrelated commands with &&; one command per call is easier to verify.
- Tests and builds can take minutes; raise timeoutMs when needed (max 10 minutes).`;

const bashParameters = obj({
	command: str({ description: "The command line to run with bash -lc." }),
	timeoutMs: opt(
		int({ description: "Timeout in milliseconds (default 120000, max 600000).", minimum: 1000, maximum: 600_000 }),
	),
	cwd: opt(str({ description: "Working directory relative to the workspace." })),
});

export function createBashTool(ctx: ToolContext): AgentTool<typeof bashParameters, JsonValue | undefined> {
	return {
		name: "bash",
		label: "Shell",
		description: BASH_DESCRIPTION,
		parameters: bashParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof bashParameters>,
			signal,
			onUpdate,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			let cwd = ctx.workspace;
			if (params.cwd) {
				const resolved = resolveInside(ctx.workspace, params.cwd);
				if (!resolved.ok) return failure(resolved.error);
				cwd = resolved.absolute;
			}
			let streamed = "";
			let lastUpdate = 0;
			const outcome = await runSandboxed(ctx, params.command, {
				timeoutMs: params.timeoutMs,
				cwd,
				signal,
				onOutput: (chunk) => {
					streamed = (streamed + chunk).slice(-4000);
					const now = Date.now();
					// Throttle partial updates: a chatty build must not flood the event stream.
					if (onUpdate && now - lastUpdate > 150) {
						lastUpdate = now;
						onUpdate({ content: [{ type: "text", text: streamed }], details: undefined });
					}
				},
			});
			if (!outcome.ok) return failure(outcome.error);
			const result = outcome.outcome;
			const combined = [result.stdout.trimEnd(), result.stderr.trimEnd()]
				.filter((part) => part.length > 0)
				.join("\n");
			const truncated = truncateOutput(combined, { maxLines: 400, maxBytes: 32_000 });
			const artifact = truncated.truncated ? ctx.artifacts.put(combined) : undefined;
			const header = `exit ${result.exitCode} · ${result.durationMs}ms${
				result.sandboxDenied ? ` · sandbox denied (${result.denialSignal}); ask the human to widen the policy` : ""
			}`;
			const note = artifact ? `\nfull output: artifact ${artifact.id}` : "";
			return {
				content: [{ type: "text", text: `${header}\n${truncated.text}${note}`.trimEnd() }],
				details: toDetails({
					exitCode: result.exitCode,
					durationMs: result.durationMs,
					sandboxDenied: result.sandboxDenied,
					truncated: truncated.truncated,
					artifact: artifact?.id,
				}),
				isError: result.exitCode !== 0,
			};
		},
	};
}
