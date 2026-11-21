import { Ai } from "@bedrock/ai";
import { compileGate } from "@bedrock/gate";
import { createId, defaultConfig, type Mission } from "@bedrock/protocol";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	advise,
	digestMessages,
	estimateTokens,
	heuristicApproaches,
	MissionController,
	maskOldObservations,
	planApproaches,
	reflect,
	renderProofMarkdown,
	STANCES,
} from "../src/index.ts";

function aiWith(texts: string[]): Ai {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
	return new Ai({ config: defaultConfig(), models });
}

const mission: Mission = {
	id: createId("mission"),
	spec: { goal: "fix the parser", mode: "run", budget: {}, isolation: "worktree" },
	status: "running",
	phase: "plan",
	createdAt: "t",
	updatedAt: "t",
	workspace: "/tmp",
	baseTree: "a",
};

describe("strategist", () => {
	it("rotates distinct stances without a model", () => {
		const first = heuristicApproaches(2, 1).map((approach) => approach.title);
		const second = heuristicApproaches(2, 2).map((approach) => approach.title);
		expect(new Set(first).size).toBe(2);
		expect(first).not.toEqual(second);
		expect(heuristicApproaches(6, 1)).toHaveLength(6);
		expect(STANCES.length).toBeGreaterThanOrEqual(4);
	});

	it("uses the model's approaches and pads with stances", async () => {
		const ai = aiWith([
			JSON.stringify({
				approaches: [{ title: "bisect history", hypothesis: "find the regression commit", risks: ["slow"] }],
			}),
		]);
		const plan = await planApproaches({ ai, mission, gate: compileGate(mission), count: 2, round: 1 });
		expect(plan.source).toBe("model");
		expect(plan.approaches[0].title).toBe("bisect history");
		expect(plan.approaches).toHaveLength(2);
	});

	it("falls back to heuristics on garbage", async () => {
		const plan = await planApproaches({
			ai: aiWith(["not json"]),
			mission,
			gate: compileGate(mission),
			count: 1,
			round: 1,
		});
		expect(plan.source).toBe("heuristic");
	});
});

const longResult = (text: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: crypto.randomUUID(),
	toolName: "bash",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});

describe("compaction", () => {
	it("masks old tool outputs past the budget and keeps recent ones", () => {
		const messages: AgentMessage[] = Array.from({ length: 10 }, (_, index) =>
			longResult(`result ${index}\n${"x".repeat(4000)}`),
		);
		expect(maskOldObservations(messages, { maxTokens: 1e9 })).toBe(messages);
		const masked = maskOldObservations(messages, { maxTokens: 5000, keepRecent: 2 });
		const texts = masked.map((message) =>
			"content" in message && Array.isArray(message.content) ? (message.content[0] as { text: string }).text : "",
		);
		expect(texts[0]).toContain("output elided");
		expect(texts[0]).toContain("result 0");
		expect(texts[9]).toContain("x".repeat(100));
		expect(estimateTokens(masked)).toBeLessThan(estimateTokens(messages));
	});
});

describe("advisor", () => {
	it("digests recent turns and returns a tagged note", async () => {
		const digest = digestMessages([longResult("FAIL test_unicode")]);
		expect(digest).toContain("FAIL test_unicode");
		const verdict = await advise({
			ai: aiWith([JSON.stringify({ tag: "concern", text: "test_unicode was skipped" })]),
			goal: "g",
			gate: compileGate(mission),
			messages: [],
		});
		expect(verdict).toEqual({ tag: "concern", text: "test_unicode was skipped" });
		expect(
			await advise({
				ai: aiWith([JSON.stringify({ tag: "none", text: "" })]),
				goal: "g",
				gate: compileGate(mission),
				messages: [],
			}),
		).toBeUndefined();
	});
});

describe("reflector", () => {
	it("proposes at most three scoped add deltas", async () => {
		const ai = aiWith([
			JSON.stringify({
				lessons: [
					{ trigger: "running tests", content: "use npm test -- --run; watch mode hangs in CI" },
					{ trigger: "x", content: "short" },
				],
			}),
		]);
		const deltas = await reflect({
			ai,
			goal: "g",
			finalState: "passed",
			scope: "repo",
			missionId: "m",
			briefs: [],
			workerSummaries: [],
		});
		expect(deltas).toEqual([
			{
				kind: "add",
				scope: "repo",
				trigger: "running tests",
				content: "use npm test -- --run; watch mode hangs in CI",
				sourceMission: "m",
			},
		]);
	});
});

describe("controller", () => {
	it("queues steering until a worker attaches and cancels with a signal", () => {
		const controller = new MissionController();
		const seen: string[] = [];
		controller.onChange((event) => seen.push(event.type));
		controller.steer("look at the lexer");
		expect(controller.pending()).toEqual(["look at the lexer"]);
		const delivered: unknown[] = [];
		const fakeAgent = { steer: (message: unknown) => delivered.push(message), abort: () => delivered.push("abort") };
		controller.attach(fakeAgent as never);
		expect(delivered).toHaveLength(1);
		expect(controller.pending()).toEqual([]);
		controller.cancel();
		expect(controller.signal.aborted).toBe(true);
		expect(delivered).toContain("abort");
		expect(seen).toEqual(["steer", "cancel"]);
	});
});

describe("proof", () => {
	it("renders verdict, gate, unverified claims and cost", () => {
		const markdown = renderProofMarkdown(
			{
				missionId: mission.id,
				finalState: "partial",
				summary: "Progress was real but incomplete.",
				diffStat: { files: 1, additions: 2, deletions: 0 },
				evidence: [],
				unverified: ["windows paths"],
				risks: ["no holdout"],
				checkpoints: [{ label: "bedrock/x", commit: "abc" }],
				cost: { usd: 0.5, tokens: 10, wallClockMs: 2000 },
				createdAt: "t",
			},
			"fix it",
		);
		expect(markdown).toContain("# Proof of work: PARTIAL");
		expect(markdown).toContain("windows paths");
		expect(markdown).toContain("bedrock/x");
	});
});
