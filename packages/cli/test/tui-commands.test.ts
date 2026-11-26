import { createId } from "@bedrock/protocol";
import { MissionApp, VirtualTerminal } from "@bedrock/tui";
import { expect, it } from "vitest";
import { missionCommand } from "../src/tui-mission.ts";

it("routes /goal to the mission start, guards a busy run and displays the recorded plan", () => {
	const terminal = new VirtualTerminal(100, 28);
	const goals: string[] = [];
	const app: MissionApp = new MissionApp({
		terminal,
		tickMs: 0,
		onCommand: (command, args) =>
			missionCommand(app, command, args, {
				workspace: process.cwd(),
				start: (goal) => goals.push(goal),
			}),
	});
	app.start();
	try {
		const submit = (line: string) => {
			for (const char of line) terminal.type(char);
			terminal.type("\r");
		};
		submit("/plan inspect the parser");
		expect(app.view.panel?.title).toContain("NO MODEL CALLS");
		expect(goals).toEqual([]);
		submit("/goal fix the parser");
		const missionId = createId("mission");
		app.apply({ type: "mission_start", missionId, goal: goals[0], workspace: "/test", at: "t" });
		submit("/goal should not start a second mission");
		expect(goals).toEqual(["fix the parser"]);
		const id = createId("strategy");
		app.apply({
			type: "strategy_node",
			missionId,
			at: "t",
			node: {
				id,
				title: "reproduce first",
				status: "running",
				hypothesis: "isolate the failing case",
				risks: [],
				children: [],
			},
		});
		submit("/plan");
		expect(app.view.panel?.lines).toContain("[running] reproduce first");
	} finally {
		app.stop();
	}
});
