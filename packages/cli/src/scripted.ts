// @bedrock/cli: a scripted model for offline demos and end-to-end tests.
//
// BEDROCK_SCRIPT=path/to/script.json replaces every role's model with pi-ai's
// faux provider replaying the script, so the full CLI, TUI and mission loop can
// run without API keys or network. It is a test and demo facility, never a
// default: a run using it says so in its first notice.

import { readFileSync } from "node:fs";
import type { BedrockConfig, Role } from "@bedrock/protocol";
import { ROLES } from "@bedrock/protocol";
import {
	type FauxContentBlock,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";

export interface ScriptStep {
	text?: string;
	tools?: Array<{ name: string; args: JsonObject }>;
}

export interface Script {
	/** Simulated streaming speed, for watching the TUI. */
	tokensPerSecond?: number;
	steps: ScriptStep[];
}

export const SCRIPTED_MODEL = "script/scripted";

/** Parses a script file. Accepts `{ steps: [...] }` or a bare array of steps. */
export function loadScript(path: string): Script {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Script | ScriptStep[];
	const script = Array.isArray(parsed) ? { steps: parsed } : parsed;
	if (!Array.isArray(script.steps) || script.steps.length === 0)
		throw new Error(`${path}: a script needs at least one step`);
	return script;
}

/** Registers the scripted provider on `models` and routes every role to it. */
export function installScript(
	models: { setProvider(provider: ReturnType<typeof fauxProvider>["provider"]): void },
	config: BedrockConfig,
	script: Script,
): void {
	const faux = fauxProvider({
		provider: "script",
		models: [{ id: "scripted", name: "Scripted", contextWindow: 200_000 }],
		tokensPerSecond: script.tokensPerSecond,
	});
	faux.setResponses(
		script.steps.map((step) => {
			const blocks: FauxContentBlock[] = [];
			if (step.text) blocks.push(fauxText(step.text));
			for (const tool of step.tools ?? []) blocks.push(fauxToolCall(tool.name, tool.args));
			return fauxAssistantMessage(blocks.length > 0 ? blocks : [fauxText("(empty step)")]);
		}),
	);
	models.setProvider(faux.provider);
	config.roles.default = SCRIPTED_MODEL;
	for (const role of ROLES as readonly Role[])
		config.roles.roles[role] = { ...config.roles.roles[role], model: SCRIPTED_MODEL, fallback: [] };
}
