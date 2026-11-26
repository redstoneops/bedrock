import { ArtifactStore } from "@bedrock/context";
import { MemoryAuditLog, Sandbox } from "@bedrock/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
	createTools,
	createWebFetchTool,
	createWebSearchTool,
	type ToolContext,
	type WebToolsOptions,
} from "../src/index.ts";
import { publicAddress, publicWebUrl, type WebRequest } from "../src/web-client.ts";

function context(preset: "standard" | "strict" = "standard"): ToolContext {
	const workspace = process.cwd();
	return {
		workspace,
		sandbox: new Sandbox({ workspace, preset, autonomous: true, audit: new MemoryAuditLog() }),
		artifacts: new ArtifactStore({ kind: "memory" }),
	};
}

describe("public web transport policy", () => {
	it("accepts only named HTTPS hosts on the default port", () => {
		expect(publicWebUrl("https://docs.example.com/path#anchor").href).toBe("https://docs.example.com/path");
		for (const url of [
			"http://example.com",
			"https://127.0.0.1",
			"https://[::1]",
			"https://localhost",
			"https://user:pass@docs.example.com",
			"https://docs.example.com:8443",
			"file:///x",
		])
			expect(() => publicWebUrl(url)).toThrow();
	});

	it("fails closed for private, special-use, or mixed DNS answers", () => {
		expect(publicAddress(["8.8.8.8", "1.1.1.1"])).toBe("8.8.8.8");
		for (const ip of [
			"0.0.0.0",
			"127.0.0.1",
			"169.254.169.254",
			"172.16.0.1",
			"192.168.0.1",
			"100.64.0.1",
			"::1",
			"224.0.0.1",
		])
			expect(() => publicAddress(["8.8.8.8", ip])).toThrow("public IPv4");
		expect(() => publicAddress([])).toThrow("public IPv4");
	});
});

describe("opt-in web tools", () => {
	it("registers search and fetch independently and leaves both off by default", () => {
		const ctx = context();
		const names = (web?: WebToolsOptions) => createTools(ctx, { web }).map((item) => item.name);
		expect(names().filter((name) => name.startsWith("web_"))).toEqual([]);
		expect(names({ braveKey: "faux" }).slice(-1)).toEqual(["web_search"]);
		expect(names({ hosts: ["example.com"] }).slice(-1)).toEqual(["web_fetch"]);
	});

	it("sends the Brave key only in its header and returns usable citations", async () => {
		const send = vi.fn<WebRequest>().mockResolvedValue({
			status: 200,
			contentType: "application/json; charset=utf-8",
			body: JSON.stringify({
				web: {
					results: [
						{
							title: "Library docs",
							url: "https://docs.example.com/read",
							description: "See the API reference.",
						},
						{ title: "Bad URL", url: "file:///tmp/a" },
					],
				},
			}),
		});
		const ctx = context();
		const tool = createWebSearchTool(ctx, "test-key", send);
		const result = await tool.execute("1", { query: "library & api", limit: 2 });
		const [url, headers] = send.mock.calls[0];
		expect(url.origin).toBe("https://api.search.brave.com");
		expect(url.searchParams.get("q")).toBe("library & api");
		expect(headers["x-subscription-token"]).toBe("test-key");
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("https://docs.example.com/read") });
		expect(result.details).toMatchObject({ count: 1 });
		expect(JSON.stringify([result, ctx.sandbox.audit])).not.toContain("test-key");
	});

	it("requires explicit approval under strict permissions even during an autonomous run", async () => {
		const ctx = context("strict");
		const send = vi
			.fn<WebRequest>()
			.mockResolvedValue({ status: 200, contentType: "text/plain", body: "A reference." });
		const tool = createWebFetchTool(ctx, ["example.com"], send);
		expect(await tool.execute("1", { url: "https://example.com" })).toMatchObject({ isError: true });
		expect(send).not.toHaveBeenCalled();
		ctx.onPermission = async (request) => request.hosts?.[0] === "example.com";
		expect((await tool.execute("2", { url: "https://example.com" })).isError).toBeUndefined();
		expect(send).toHaveBeenCalledOnce();
	});

	it("does not contact other hosts, follow redirects, or send requests after cancellation", async () => {
		const send = vi.fn<WebRequest>().mockResolvedValue({ status: 302, contentType: "", body: "" });
		const tool = createWebFetchTool(context(), ["docs.example.com"], send);
		expect(await tool.execute("1", { url: "https://mirror.docs.example.com" })).toMatchObject({ isError: true });
		expect(await tool.execute("2", { url: "https://docs.example.com" }, AbortSignal.abort())).toMatchObject({
			isError: true,
		});
		expect(send).not.toHaveBeenCalled();
		const redirected = await tool.execute("3", { url: "https://docs.example.com" });
		expect(redirected.content[0]).toMatchObject({ text: expect.stringContaining("redirect refused") });
		expect(send).toHaveBeenCalledOnce();
	});

	it("clips a very long HTML line and stores the sanitized body as an artifact", async () => {
		const ctx = context();
		const send: WebRequest = async () => ({
			status: 200,
			contentType: "text/html",
			body: `<p>${"x".repeat(40_000)}</p>\x1b`,
		});
		const result = await createWebFetchTool(ctx, ["example.com"], send).execute("1", {
			url: "https://example.com/docs",
		});
		expect(result.isError).toBeUndefined();
		expect(JSON.stringify(result.content).length).toBeLessThan(15_000);
		const { artifactId } = result.details as { artifactId: string };
		expect(ctx.artifacts.getById(artifactId)).toContain("x".repeat(40_000));
		expect(ctx.artifacts.getById(artifactId)).not.toContain("\x1b");
	});
});
