// @bedrock/core: tools that need the gate, the ledger or the kernel.
//
// `checks` lets a worker run the visible gate itself. Every run is recorded as an
// evidence entry bound to a tree hash, so the worker's claims and the
// verifier's verdict rest on the same kind of proof. Holdout checks are never
// reachable from here.

import type { ArtifactStore } from "@bedrock/context";
import { describeResult, runGateAsync } from "@bedrock/gate";
import type { Kernel } from "@bedrock/kernel";
import { createId, type Evidence, type Gate, type Id } from "@bedrock/protocol";
import type { LedgerSink } from "@bedrock/tools";
import { toDetails } from "@bedrock/tools";
import type { AgentTool, AgentToolParams, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";

const checksParameters = obj({
	only: opt(arr(str(), { description: "Check names to run; omit to run every visible check." })),
});

/** The worker-facing gate runner. Visible checks only; results become ledger evidence. */
export function createChecksTool(context: {
	gate: Gate;
	workspace: string;
	missionId: Id<"mission">;
	ledger: LedgerSink;
	artifacts?: ArtifactStore;
	baseCommit?: string;
	onEvidence?: (entry: Evidence) => void;
}): AgentTool<typeof checksParameters, JsonValue | undefined> {
	const names = context.gate.checks.filter((check) => check.visibility === "visible").map((check) => check.name);
	return {
		name: "checks",
		label: "Checks",
		description: `Run the gate's visible checks in your workspace and get a structured verdict. Visible checks: ${names.join(", ") || "(none)"}. Holdout checks also exist; they are not available here and run only at verification. Each run is recorded as evidence in the ledger.`,
		parameters: checksParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof checksParameters>,
			signal,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			const result = await runGateAsync({
				signal,
				gate: context.gate,
				workspace: context.workspace,
				includeHoldout: false,
				only: params.only ? [...params.only] : undefined,
				artifacts: context.artifacts,
				baseCommit: context.baseCommit,
			});
			const summary = describeResult(result);
			const failing = result.visible.filter((run) => run.status !== "passed");
			const detail = failing
				.map(
					(run) => `--- ${run.name} (exit ${run.exitCode ?? "?"}) ---\n${run.outputTail ?? run.outputHead ?? ""}`,
				)
				.join("\n");
			const evidence: Evidence = {
				id: createId("entry"),
				missionId: context.missionId,
				kind: "evidence",
				author: "harness",
				createdAt: new Date().toISOString(),
				command: params.only?.length ? `checks ${params.only.join(",")}` : "checks (visible gate)",
				exitCode: result.passed ? 0 : 1,
				treeHash: result.treeHash,
				summary: `${result.visible.filter((run) => run.status === "passed").length}/${result.visible.length} visible checks passed`,
				tags: ["gate"],
			};
			context.ledger.append(evidence);
			context.onEvidence?.(evidence);
			return {
				content: [{ type: "text", text: `${summary}${detail ? `\n\n${detail}` : ""}` }],
				details: toDetails({
					passed: result.passed,
					passRatio: result.passRatio,
					treeHash: result.treeHash,
					exitCode: result.passed ? 0 : 1,
				}),
				isError: !result.passed,
			};
		},
	};
}

const pythonParameters = obj({
	code: str({
		description: "Python code. Variables persist between calls; the value of a trailing expression is returned.",
	}),
});

/**
 * The kernel as a tool: context as a variable. Load a large log once, then slice,
 * count and summarize it without pasting it into the conversation.
 */
export function createPythonTool(kernel: Kernel): AgentTool<typeof pythonParameters, JsonValue | undefined> {
	return {
		name: "python",
		label: "Python",
		description:
			"Run Python in a persistent kernel rooted at the workspace. Variables survive between calls, so load big files or logs once and query them. Helpers: read(path, offset, limit), write(path, text), ls(path), grep(pattern, path), spawn(role, brief). Print only what you need; output over 8 KB is truncated.",
		parameters: pythonParameters,
		execute: async (
			_toolCallId,
			params: AgentToolParams<typeof pythonParameters>,
		): Promise<AgentToolResult<JsonValue | undefined>> => {
			if (!kernel.running) await kernel.start();
			const result = await kernel.execute(params.code);
			const parts = [
				result.stdout,
				result.result ? `=> ${result.result}` : "",
				result.error ? result.error.traceback : result.stderr,
			].filter((part) => part.length > 0);
			let text = parts.join("\n").trimEnd() || "(no output)";
			if (text.length > 8192)
				text = `${text.slice(0, 4096)}\n... [truncated ${text.length - 8192} chars] ...\n${text.slice(-4096)}`;
			return {
				content: [{ type: "text", text }],
				details: toDetails({ ok: result.ok, durationMs: result.durationMs }),
				isError: !result.ok,
			};
		},
	};
}
