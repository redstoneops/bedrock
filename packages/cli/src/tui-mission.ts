// Mission-specific commands inspect the same strategy events the cockpit draws.

import { scout } from "@bedrock/core";
import type { MissionApp } from "@bedrock/tui";

export function missionCommand(
	app: MissionApp,
	command: string,
	args: string,
	options: { workspace: string; proof?: string; start?: (goal: string) => void },
): boolean {
	switch (command) {
		case "goal":
			if (!options.start) app.note("/goal is available in Mission Control; quick mode has no verification gate");
			else if (app.view.busy) app.note("A mission or account action is running; send plain text to steer a mission");
			else if (!args) app.note("Usage: /goal <what should be verified>");
			else options.start(args);
			return true;
		case "plan":
			if (args) app.showPanel("PLAN PREVIEW · NO MODEL CALLS OR EDITS", preview(options.workspace, args));
			else {
				const { rootId, nodes, rationale } = app.view.strategy;
				const approaches = Object.values(nodes).filter((node) => node.id !== rootId);
				app.showPanel("MISSION PLAN", [
					app.view.goal ? `Goal: ${app.view.goal}` : "No mission is running.",
					rationale ?? "No strategy recorded yet. Use /plan <goal> for a local preview.",
					...approaches.flatMap((node) => [
						"",
						`[${node.status}] ${node.title}`,
						`  ${node.hypothesis}`,
						...node.risks.map((risk) => `  Risk: ${risk}`),
					]),
				]);
			}
			return true;
		case "proof":
			app.note(options.proof ? `proof of work: ${options.proof}` : "no mission has finished in this session");
			return true;
		default:
			return false;
	}
}

function preview(workspace: string, goal: string): string[] {
	const report = scout({ workspace });
	const checks = Object.entries(report.commands).filter(([, command]) => command);
	return [
		`Goal: ${goal}`,
		`Workspace: ${workspace}`,
		"",
		"1. Scout the repository and compile the verification gate.",
		...(checks.length
			? checks.map(([name, command]) => `   Detected ${name}: ${command}`)
			: ["   No check commands detected; supply --gate when running."]),
		"2. Attempt the smallest change in an isolated workspace.",
		"3. Verify the candidate independently and record a proof.",
		"",
		"This is a local preview, not the strategist's eventual plan.",
		"Start from Mission Control with /goal <goal>.",
	];
}
