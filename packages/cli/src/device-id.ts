import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultAuthPath } from "@bedrock/ai";

/** OpenAI OAuth requires a stable installation UUID, shared across concurrent CLI sessions. */
export function deviceId(home = dirname(defaultAuthPath())): string {
	const path = join(home, "device-id");
	try {
		return readFileSync(path, "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const id = randomUUID();
	const temporary = join(home, `.device-id.${id}`);
	writeFileSync(temporary, id, { flag: "wx", mode: 0o600 });
	try {
		linkSync(temporary, path);
		return id;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return readFileSync(path, "utf8").trim();
	} finally {
		rmSync(temporary, { force: true });
	}
}
