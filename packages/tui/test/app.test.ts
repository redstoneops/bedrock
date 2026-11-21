import { createId, type GateResult } from "@bedrock/protocol";
import { describe, expect, it } from "vitest";
import { MissionApp, VirtualTerminal } from "../src/index.ts";

const missionId = createId("mission");
const workerId = createId("worker");

function app(options: ConstructorParameters<typeof MissionApp>[0] = {}): {
	app: MissionApp;
	terminal: VirtualTerminal;
} {
	const terminal = new VirtualTerminal(100, 28);
	const instance = new MissionApp({ terminal, tickMs: 0, ...options });
	instance.start();
	return { app: instance, terminal };
}

function flush(instance: MissionApp): void {
	instance.tui.renderNow(true);
}

function typeLine(terminal: VirtualTerminal, text: string): void {
	for (const char of text) terminal.type(char);
	terminal.type("\r");
}

const passed: GateResult = {
	gateId: createId("gate"),
	gateVersion: 1,
	treeHash: "0123456789abcdef",
	startedAt: "t",
	finishedAt: "t",
	visible: [{ checkId: createId("check"), name: "test", status: "passed", durationMs: 1200, startedAt: "t" }],
	holdout: [{ checkId: createId("check"), name: "holdout-1", status: "passed", durationMs: 10, startedAt: "t" }],
	invariantViolations: [],
	integrity: { changedPaths: [], protectedTouched: [], unjustified: [], suspicious: [], clean: true },
	passed: true,
	passRatio: 1,
};

describe("MissionApp on a virtual terminal", () => {
	it("draws the cockpit and streams a mission to its proof of work", () => {
		const { app: instance, terminal } = app();
		flush(instance);
		expect(terminal.transcript()).toContain("describe a mission to start");
		instance.apply({ type: "mission_start", missionId, goal: "make the tests pass", workspace: "/w", at: "t" });
		instance.apply({ type: "mission_phase", missionId, phase: "execute", at: "t" });
		instance.apply({
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
				turnCap: 10,
				kernel: false,
			},
		});
		instance.apply({ type: "assistant_delta", missionId, workerId, text: "", append: false, at: "t" });
		instance.apply({
			type: "assistant_delta",
			missionId,
			workerId,
			text: "Reading **the failing test** first.",
			append: true,
			at: "t",
		});
		instance.apply({
			type: "tool_call",
			missionId,
			at: "t",
			card: {
				toolCallId: "c1",
				workerId,
				name: "bash",
				args: {},
				label: "$ npm test",
				status: "running",
				startedAt: "t",
			},
		});
		flush(instance);
		instance.apply({
			type: "tool_call",
			missionId,
			at: "t",
			card: {
				toolCallId: "c1",
				workerId,
				name: "bash",
				args: {},
				label: "$ npm test",
				status: "ok",
				startedAt: "t",
				exitCode: 0,
				head: "exit 0 · 900ms\nall tests passed",
			},
		});
		instance.apply({ type: "verification", missionId, workerId, level: 2, result: passed, at: "t" });
		flush(instance);
		const live = terminal.transcript();
		expect(live).toContain("make the tests pass");
		expect(live).toContain("the failing test");
		expect(live).not.toContain("**the failing test**");
		expect(live).toContain("$ npm test");
		expect(live).toContain("GATE 2/2");
		// The running card was updated in place, not duplicated.
		expect(instance.view.conversation.filter((line) => line.kind === "tool")).toHaveLength(1);

		instance.apply({
			type: "mission_finish",
			missionId,
			finalState: "passed",
			at: "t",
			proof: {
				missionId,
				finalState: "passed",
				summary: "The gate passed on a tree whose hash is recorded.",
				diffStat: { files: 1, additions: 3, deletions: 1 },
				gate: passed,
				evidence: [],
				unverified: [],
				risks: [],
				checkpoints: [],
				cost: { usd: 0.42, tokens: 1200, wallClockMs: 61_000 },
				createdAt: "t",
			},
		});
		flush(instance);
		expect(terminal.transcript()).toContain("PROOF OF WORK — PASSED");
		expect(instance.view.busy).toBe(false);
		for (const line of terminal.screen()) expect(line.length).toBeLessThanOrEqual(100);
		instance.stop();
	});

	it("submits typed text, routes steering while busy and interrupts on Esc", () => {
		const submitted: string[] = [];
		let interrupts = 0;
		const { app: instance, terminal } = app({
			onSubmit: (text) => submitted.push(text),
			onInterrupt: () => interrupts++,
		});
		typeLine(terminal, "fix the parser");
		expect(submitted).toEqual(["fix the parser"]);
		instance.setBusy(true);
		typeLine(terminal, "try the lexer");
		expect(submitted).toEqual(["fix the parser", "try the lexer"]);
		expect(instance.view.conversation.some((line) => line.text.includes("you (steering): try the lexer"))).toBe(true);
		terminal.type("\u001b");
		// pi-tui waits briefly to tell a lone Esc from an escape sequence.
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				expect(interrupts).toBe(1);
				instance.stop();
				resolve();
			}, 150);
		});
	});

	it("answers questions with the next submission and handles slash commands", async () => {
		const quits: number[] = [];
		const { app: instance, terminal } = app({ onQuit: () => quits.push(1) });
		const answer = instance.ask("Widen the sandbox?", ["yes", "no"]);
		flush(instance);
		expect(terminal.transcript()).toContain("Widen the sandbox? [yes / no]");
		typeLine(terminal, "yes");
		await expect(answer).resolves.toBe("yes");
		typeLine(terminal, "/help");
		expect(instance.view.conversation.some((line) => line.text.startsWith("/agents"))).toBe(true);
		typeLine(terminal, "/agents");
		expect(instance.view.expanded).toBe("agents");
		typeLine(terminal, "/nope");
		expect(instance.view.conversation.at(-1)?.text).toContain("unknown command /nope");
		typeLine(terminal, "/quit");
		expect(quits).toHaveLength(1);
		instance.stop();
	});

	it("uses the chat layout for quick mode", () => {
		const { app: instance, terminal } = app({ layout: "chat" });
		flush(instance);
		const text = terminal.transcript();
		expect(text).toContain("quick");
		expect(text).not.toContain("STRATEGY");
		instance.stop();
	});
});
