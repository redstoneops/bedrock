import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): FileCredentialStore {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-auth-"));
	dirs.push(dir);
	return new FileCredentialStore(join(dir, "auth.json"));
}

it("persists keys and OAuth credentials with private permissions and lists only metadata", async () => {
	const first = store();
	await first.modify("deepseek", async () => ({ type: "api_key", key: "faux-key" }));
	await first.modify("openai", async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: 1 }));
	const second = new FileCredentialStore(first.path);
	expect(await second.read("deepseek")).toEqual({ type: "api_key", key: "faux-key" });
	expect(await second.list()).toEqual([
		{ providerId: "deepseek", type: "api_key" },
		{ providerId: "openai", type: "oauth" },
	]);
	if (process.platform !== "win32") expect(statSync(first.path).mode & 0o777).toBe(0o600);
	await second.delete("deepseek");
	expect(await first.read("deepseek")).toBeUndefined();
});

it("serializes refresh and mutation across instances without losing credentials", async () => {
	const first = store();
	const second = new FileCredentialStore(first.path);
	const [refreshed, observed] = await Promise.all([
		first.modify("openai", async () => ({ type: "api_key", key: "new" })),
		second.modify("openai", async (current) => {
			expect(current).toEqual({ type: "api_key", key: "new" });
			return undefined;
		}),
		second.modify("deepseek", async () => ({ type: "api_key", key: "other" })),
	]);
	expect(observed).toEqual(refreshed);
	expect(await second.list()).toHaveLength(2);
});

it("fails closed without overwriting malformed state", async () => {
	const credentials = store();
	writeFileSync(credentials.path, "{");
	await expect(credentials.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow(
		"cannot read credentials",
	);
	expect(readFileSync(credentials.path, "utf8")).toBe("{");
});
