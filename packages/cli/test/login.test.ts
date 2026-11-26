import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@bedrock/ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, it } from "vitest";
import { deviceId } from "../src/device-id.ts";
import { showProviders, signIn, signOut } from "../src/login.ts";

it("signs in with the real DeepSeek key prompt, reloads auth and logs out without a network request", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bedrock-login-"));
	try {
		const path = join(dir, "auth.json");
		const models = builtinModels({ credentials: new FileCredentialStore(path) });
		const lines: string[] = [];
		const say = (text: string) => lines.push(text);
		const key = "test-only-faux-deepseek-key";
		expect(await signIn(models, { say, ask: async () => undefined, askSecret: async () => key }, "deepseek")).toBe(
			"deepseek",
		);
		const reopened = builtinModels({ credentials: new FileCredentialStore(path) });
		expect(await reopened.checkAuth("deepseek")).toMatchObject({ type: "api_key" });
		await showProviders(reopened, say, "deepseek");
		expect(lines).toContain("deepseek · api-key · configured");
		expect(lines.join("\n")).not.toContain(key);
		await signOut(reopened, "deepseek", say);
		expect(await new FileCredentialStore(path).read("deepseek")).toBeUndefined();
		expect(deviceId(dir)).toMatch(/^[0-9a-f-]{36}$/);
		expect(deviceId(dir)).toBe(deviceId(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
