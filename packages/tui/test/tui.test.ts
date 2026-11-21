import { stripVTControlCharacters } from "node:util";
import { type BedrockEvent, createId, type GateResult } from "@bedrock/protocol";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MissionControl, MissionView, renderMission, renderProof, wrap } from "../src/index.ts";

const missionId = createId("mission");

function gateResult(passed: boolean): GateResult {
	return {
		gateId: createId("gate"),
		gateVersion: 1,
		treeHash: "abc",
		startedAt: "t",
		finishedAt: "t",
		visible: [
			{ checkId: createId("check"), name: "build", status: "passed", durationMs: 12, startedAt: "t" },
			{
				checkId: createId("check"),
				name: "test_unicode",
				status: passed ? "passed" : "failed",
				durationMs: 40,
				startedAt: "t",
				failureReason: "assertion",
			},
		],
		holdout: [{ checkId: createId("check"), name: "holdout-1", status: "passed", durationMs: 5, startedAt: "t" }],
		invariantViolations: [],
		integrity: { changedPaths: [], protectedTouched: [], unjustified: [], suspicious: [], clean: true },
		passed,
		passRatio: passed ? 1 : 0.66,
	};
}

function populate(view: MissionView): MissionView {
	const workerId = createId("worker");
	const events: BedrockEvent[] = [
		{ type: "mission_start", missionId, goal: "port the parser to Rust", workspace: "/w", at: "t" },
		{
			type: "gate_compiled",
			missionId,
			gateId: createId("gate"),
			version: 1,
			checks: 2,
			checkList: [
				{ name: "build", command: "npm run build", holdout: false },
				{ name: "holdout-1", command: "(hidden)", holdout: true },
			],
			at: "t",
		},
		{
			type: "strategy_tree",
			missionId,
			at: "t",
			tree: {
				id: createId("strategy"),
				missionId,
				rootId: createId("strategy"),
				createdAt: "t",
				rationale: "r",
				nodes: {},
			},
		},
		{
			type: "worker_spawned",
			missionId,
			workerId,
			at: "t",
			spec: {
				missionId,
				strategyId: createId("strategy"),
				role: "worker",
				brief: "b",
				workspace: "/w",
				baseCommit: "c",
				turnCap: 120,
				kernel: false,
			},
		},
		{ type: "assistant_delta", missionId, workerId, text: "I will start with the lexer.", append: false, at: "t" },
		{
			type: "tool_call",
			missionId,
			at: "t",
			card: {
				toolCallId: "1",
				workerId,
				name: "edit",
				args: {},
				label: "edit src/lexer.rs",
				status: "ok",
				startedAt: "t",
				diffStat: { additions: 42, deletions: 3 },
			},
		},
		{
			type: "advisor_note",
			missionId,
			at: "t",
			note: { id: createId("entry"), workerId, tag: "concern", text: "test_unicode is skipped?", createdAt: "t" },
		},
		{ type: "mission_phase", missionId, phase: "execute", at: "t" },
		{
			type: "ledger_summary",
			missionId,
			at: "t",
			summary: {
				total: 23,
				byKind: {
					fact: 12,
					hypothesis: 4,
					decision: 2,
					evidence: 3,
					risk: 2,
					question: 0,
					artifact: 0,
					checkpoint: 0,
					candidate: 0,
				},
				openHypotheses: 4,
				risks: 2,
				unsupportedRatio: 0.2,
			},
		},
		{ type: "verification", missionId, workerId, level: 2, result: gateResult(true), at: "t" },
	];
	const treeEvent = events.find((event) => event.type === "strategy_tree");
	const treeData = treeEvent && treeEvent.type === "strategy_tree" ? treeEvent.tree : undefined;
	for (const event of events) view.apply(event);
	if (treeData) {
		const root = createId("strategy");
		view.strategy.rootId = root;
		view.strategy.nodes[root] = {
			id: root,
			title: "root",
			hypothesis: "port it",
			risks: [],
			status: "running",
			children: [],
		};
		const child = createId("strategy");
		view.strategy.nodes[child] = {
			id: child,
			parentId: root,
			title: "B incremental",
			hypothesis: "h",
			risks: [],
			status: "passed",
			children: [],
		};
		view.strategy.nodes[root].children = [child];
	}
	return view;
}

describe("MissionView", () => {
	it("projects events into state", () => {
		const view = populate(new MissionView());
		expect(view.goal).toBe("port the parser to Rust");
		expect(view.phase).toBe("execute");
		expect(view.workers.size).toBe(1);
		expect(view.gate).toHaveLength(3);
		expect(view.gatePassRatio).toBe(1);
		expect(view.ledger.total).toBe(23);
		expect(view.conversation.some((line) => line.kind === "advisor" && line.tag === "concern")).toBe(true);
		expect(view.conversation.some((line) => line.kind === "tool")).toBe(true);
	});

	it("appends streamed deltas to the same message", () => {
		const view = new MissionView();
		const workerId = createId("worker");
		view.apply({ type: "assistant_delta", missionId, workerId, text: "Hello ", append: false, at: "t" });
		view.apply({ type: "assistant_delta", missionId, workerId, text: "world", append: true, at: "t" });
		expect(view.conversation.at(-1)?.text).toBe("Hello world");
	});

	it("edits and submits steering, and handles control keys", () => {
		const view = new MissionView();
		expect(view.handleInput("t")).toBe("none");
		expect(view.handleInput("r")).toBe("none");
		view.handleInput("\u007f");
		expect(view.steering).toBe("t");
		expect(view.handleInput("\u000b")).toBe("toggle-agents");
		expect(view.handleInput("\r")).toBe("submit");
		expect(view.submitSteering()).toBe("t");
		expect(view.handleInput("\u001b[A")).toBe("none");
		expect(view.steering).toBe("");
		expect(view.handleInput("\u001b")).toBe("interrupt");
	});

	it("renders the proof of work after the mission finishes", () => {
		const view = new MissionView();
		view.apply({
			type: "mission_finish",
			missionId,
			finalState: "partial",
			at: "t",
			proof: {
				missionId,
				finalState: "partial",
				summary: "Progress was real but incomplete: 66% of checks passed.",
				diffStat: { files: 2, additions: 10, deletions: 1 },
				evidence: [],
				unverified: ["windows behaviour"],
				risks: ["flaky test"],
				checkpoints: [],
				cost: { usd: 1.5, tokens: 9000, wallClockMs: 65_000 },
				createdAt: "t",
			},
		});
		const proof = renderProof(view, 100).join("\n");
		expect(proof).toContain("PARTIAL");
		expect(proof).toContain("windows behaviour");
		expect(proof).toContain("$1.50");
	});
});

describe("renderMission", () => {
	it("renders within 80x24 with no line wider than the viewport", () => {
		const view = populate(new MissionView());
		const lines = renderMission(view, 80, 24);
		expect(lines.length).toBeLessThanOrEqual(24);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		const text = lines.map((line) => stripVTControlCharacters(line)).join("\n");
		expect(text).toContain("Bedrock");
		expect(text).toContain("STRATEGY");
		expect(text).toContain("GATE 3/3");
		expect(text).toContain("LEDGER");
		expect(text).toContain("edit src/lexer.rs");
		expect(text).toContain("advisor concern");
		expect(text).toContain("> ");
	});

	it("stacks panes on a narrow terminal", () => {
		const view = populate(new MissionView());
		const lines = renderMission(view, 40, 24);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		const text = lines.map((line) => stripVTControlCharacters(line)).join("\n");
		expect(text).toContain("STRATEGY");
	});

	it("shows a locked holdout row when holdouts ran", () => {
		const view = populate(new MissionView());
		const text = renderMission(view, 100, 30)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		expect(text).toContain("holdout-1");
		expect(text).toContain("🔒");
	});
});

describe("MissionControl component", () => {
	it("clips every line to the given width and routes steering", () => {
		const control = new MissionControl(populate(new MissionView()));
		const steer: string[] = [];
		control.onSteer = (text) => steer.push(text);
		for (const char of "try approach B") control.handleInput(char);
		control.handleInput("\r");
		expect(steer).toEqual(["try approach B"]);
		const lines = control.render(60, 20);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("toggles the agent hub and reports interrupts", () => {
		const control = new MissionControl(populate(new MissionView()));
		let interrupted = false;
		control.onInterrupt = () => {
			interrupted = true;
		};
		control.handleInput("\u000b");
		expect(control.view.expanded).toBe("agents");
		expect(
			control
				.render(80, 24)
				.map((line) => stripVTControlCharacters(line))
				.join("\n"),
		).toContain("AGENTS");
		control.handleInput("\u001b");
		expect(interrupted).toBe(true);
	});
});

describe("wrap", () => {
	it("wraps on word boundaries and keeps explicit newlines", () => {
		expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
		expect(wrap("a\nb", 10)).toEqual(["a", "b"]);
	});
});

describe("pending gate rows", () => {
	it("shows compiled checks as pending before verification", () => {
		const view = new MissionView();
		view.apply({
			type: "gate_compiled",
			missionId,
			gateId: createId("gate"),
			version: 1,
			checks: 2,
			checkList: [
				{ name: "test", command: "npm test", holdout: false },
				{ name: "h", command: "(hidden)", holdout: true },
			],
			at: "t",
		});
		const text = renderMission(view, 100, 20)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		expect(text).toContain("GATE 0/2");
		expect(text).toContain("· test");
	});
});
