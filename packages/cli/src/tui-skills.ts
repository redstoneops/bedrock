import type { MissionApp } from "@bedrock/tui";
import { addSkill, listSkills, skillContext, skillsDirectory } from "./user-skills.ts";

export function tuiSkills(app: MissionApp, workspace: string, initial: string[]) {
	let active = initial;
	const activate = (name: string) => {
		const next = name === "!off" ? [] : [name];
		skillContext(next);
		active = next;
		app.note(active.length ? `Skill selected: ${name}.` : "Skills disabled for this session.");
	};
	return {
		context: () => skillContext(active),
		command(command: string, args: string): boolean {
			if (command !== "skills" && command !== "skill") return false;
			if (app.view.busy) {
				app.note("Manage skills when the session is idle.");
				return true;
			}
			try {
				if (command === "skill") {
					if (args) activate(args === "off" ? "!off" : args);
					else {
						const installed = listSkills().filter((skill) => skill.valid);
						void app
							.choose(`Select a skill · active: ${active.join(", ") || "none"}`, [
								{ value: "!off", label: "No skill", description: "Disable session skills" },
								...installed.map(({ name, description }) => ({ value: name, label: name, description })),
							])
							.then((name) => {
								if (name) activate(name);
							})
							.catch((error: Error) => app.note(error.message));
					}
				} else if (command === "skills" && args.startsWith("add ")) {
					const skill = addSkill(args.slice(4).trim(), workspace);
					app.note(`Installed ${skill.name}. Use /skill ${skill.name} to activate it.`);
				} else if (!args) {
					const installed = listSkills();
					app.showPanel("USER SKILLS", [
						`Directory: ${skillsDirectory()}`,
						`Active: ${active.join(", ") || "none"}`,
						"Install: /skills add <path> · activate: /skill <name> · disable: /skill off",
						"",
						...(installed.length
							? installed.map(({ name, description }) => `${name}${description ? ` — ${description}` : ""}`)
							: ["No skills installed."]),
					]);
				} else app.note("Usage: /skills [add <path>] or /skill <name|off>");
			} catch (error) {
				app.note((error as Error).message);
			}
			return true;
		},
	};
}
