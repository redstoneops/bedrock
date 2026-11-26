// Machine-written preferences, separate from hand-edited YAML config.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultAuthPath } from "@bedrock/ai";

function settingsPath(): string {
	return join(dirname(defaultAuthPath()), "settings.json");
}

export function savedModel(path = settingsPath()): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown } | null;
		return typeof parsed?.model === "string" ? parsed.model : undefined;
	} catch {
		return undefined;
	}
}

export function saveModel(model?: string, path = settingsPath()): void {
	mkdirSync(dirname(path), { mode: 0o700, recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ model }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
