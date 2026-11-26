// @bedrock/cli: running pi-ai login flows from a plain terminal or from the TUI.
//
// A login flow asks questions (text, secret, a choice, a pasted code) and
// reports events (a URL to open, a device code, progress). Each surface turns
// those into its own UI through `Asker`; secrets are never echoed.

import { spawn } from "node:child_process";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { listProviders, loginProvider, logoutProvider } from "@bedrock/ai";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, MutableModels } from "@earendil-works/pi-ai";
import { deviceId } from "./device-id.ts";

/** The minimal UI a login flow needs. */
export interface Asker {
	ask(question: string, signal?: AbortSignal): Promise<string | undefined>;
	askSecret(question: string, signal?: AbortSignal): Promise<string | undefined>;
	select?(
		title: string,
		items: { value: string; label: string; description?: string }[],
		signal?: AbortSignal,
	): Promise<string | undefined>;
	say(text: string): void;
}

/** Opens a URL in the user's browser, best effort and never blocking. */
export function openBrowser(url: string): void {
	try {
		if (process.platform === "win32" || new URL(url).protocol !== "https:") return;
		const command = process.platform === "darwin" ? "open" : "xdg-open";
		const child = spawn(command, [url], { stdio: "ignore", detached: true });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// No browser: the URL is printed anyway.
	}
}

/** Adapts an Asker to pi-ai's AuthInteraction. */
export function interactionFrom(asker: Asker, signal?: AbortSignal): AuthInteraction {
	return {
		signal,
		async prompt(prompt: AuthPrompt): Promise<string> {
			const promptSignal =
				prompt.signal && signal ? AbortSignal.any([prompt.signal, signal]) : (prompt.signal ?? signal);
			promptSignal?.throwIfAborted();
			let answer: string | undefined;
			if (prompt.type === "secret" || prompt.type === "manual_code")
				answer = await asker.askSecret(prompt.message, promptSignal);
			else if (prompt.type === "select" && asker.select) {
				answer = await asker.select(
					prompt.message,
					prompt.options.map(({ id, label, description }) => ({
						value: id,
						label,
						description,
					})),
					promptSignal,
				);
			} else if (prompt.type === "select") {
				for (const [index, option] of prompt.options.entries()) {
					asker.say(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
				}
				const raw = await asker.ask(`${prompt.message} [1-${prompt.options.length}]`, promptSignal);
				const index = Number(raw) - 1;
				answer =
					prompt.options[index]?.id ??
					prompt.options.find((option) => option.id === raw || option.label === raw)?.id;
			} else
				answer = await asker.ask(
					prompt.placeholder ? `${prompt.message} (${prompt.placeholder})` : prompt.message,
					promptSignal,
				);
			promptSignal?.throwIfAborted();
			if (answer === undefined || answer.trim().length === 0) throw new Error("login cancelled");
			return answer.trim();
		},
		notify(event: AuthEvent): void {
			if (signal?.aborted) return;
			switch (event.type) {
				case "auth_url":
					asker.say(`Open this URL to sign in: ${event.url}`);
					if (event.instructions) asker.say(event.instructions);
					openBrowser(event.url);
					break;
				case "device_code":
					asker.say(`Go to ${event.verificationUri} and enter the code: ${event.userCode}`);
					break;
				case "info":
					asker.say(event.message);
					for (const link of event.links ?? []) asker.say(`  ${link.label ?? link.url}: ${link.url}`);
					break;
				case "progress":
					asker.say(event.message);
					break;
			}
		},
	};
}

/** A readline Asker for `bedrock login`; secrets are read with echo off. */
export function terminalAsker(): Asker {
	return {
		say: (text) => stdout.write(`${text}\n`),
		async ask(question, signal) {
			const rl = createInterface({ input: stdin, output: stdout });
			const closed = new AbortController();
			rl.once("close", () => closed.abort());
			try {
				return await rl.question(`${question} > `, {
					signal: signal ? AbortSignal.any([signal, closed.signal]) : closed.signal,
				});
			} catch (error) {
				if (!(error instanceof Error) || error.name !== "AbortError") throw error;
				return undefined;
			} finally {
				rl.close();
			}
		},
		askSecret(question, signal) {
			return new Promise((resolve) => {
				if (!stdin.isTTY || signal?.aborted) return resolve(undefined);
				stdout.write(`${question} (input hidden) > `);
				let value = "";
				const wasRaw = stdin.isRaw;
				stdin.setRawMode(true);
				stdin.resume();
				const onData = (chunk: Buffer) => {
					for (const char of chunk.toString("utf8")) {
						if (char === "\r" || char === "\n") {
							finish(value);
							return;
						}
						if (char === "\u0003" || char === "\u001b") {
							finish(undefined);
							return;
						}
						if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
						else if (char >= " ") value += char;
					}
				};
				const finish = (result: string | undefined) => {
					stdin.off("data", onData);
					signal?.removeEventListener("abort", cancel);
					stdin.setRawMode(wasRaw);
					stdin.pause();
					stdout.write("\n");
					resolve(result);
				};
				const cancel = () => finish(undefined);
				signal?.addEventListener("abort", cancel, { once: true });
				stdin.on("data", onData);
			});
		},
	};
}

export async function showProviders(models: MutableModels, say: Asker["say"], query = ""): Promise<void> {
	const providers = (await listProviders(models)).filter(({ id }) => id.includes(query));
	if (!providers.length) say("No matching providers.");
	for (const provider of providers) {
		const methods = [provider.oauth && "oauth", provider.apiKey && "api-key"].filter(Boolean);
		say(
			`${provider.id} · ${methods.join(" / ") || "environment only"} · ${provider.configured ? "configured" : "not configured"}`,
		);
	}
}

export async function signIn(
	models: MutableModels,
	asker: Asker,
	providerId?: string,
	method?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!providerId) {
		if (asker.select) {
			const providers = await listProviders(models);
			providerId = await asker.select(
				"Sign in · choose a provider",
				providers
					.filter((provider) => provider.apiKey || provider.oauth)
					.map((provider) => ({
						value: provider.id,
						label: provider.id,
						description: [
							provider.name,
							provider.oauth && "OAuth",
							provider.apiKey && "API key",
							provider.configured && "configured",
						]
							.filter(Boolean)
							.join(" · "),
					})),
				signal,
			);
		} else {
			asker.say("Popular providers: anthropic, openai, deepseek, google, openrouter, github-copilot");
			providerId = (await asker.ask("Provider ID (see /providers or bedrock providers)", signal))?.trim();
		}
		if (!providerId) return undefined;
	}
	const provider = models.getProvider(providerId);
	if (!provider) throw new Error("unknown provider; use /providers or bedrock providers");
	const apiKey = provider.auth.apiKey;
	const oauth = provider.auth.oauth;
	if (!method && oauth && apiKey?.login) {
		if (asker.select) {
			method = await asker.select(
				`${provider.name} · sign-in method`,
				[
					{ value: "oauth", label: oauth.loginLabel ?? oauth.name, description: "OAuth" },
					{ value: "api-key", label: apiKey.name, description: "API key" },
				],
				signal,
			);
			if (!method) return undefined;
		} else {
			asker.say(`oauth: ${oauth.loginLabel ?? oauth.name} · api-key: ${apiKey.name}`);
			const answer = await asker.ask("Method [Enter for OAuth, or type api-key]", signal);
			if (answer === undefined) return undefined;
			method = answer.trim() || "oauth";
		}
	}
	const selected = method ?? (oauth ? "oauth" : apiKey?.login ? "api-key" : undefined);
	if (!selected) throw new Error(`${provider.name} uses ambient credentials; check the provider's setup instructions`);
	const type: AuthType | undefined = selected === "api-key" ? "api_key" : selected === "oauth" ? "oauth" : undefined;
	if (!type) throw new Error("authentication method must be oauth or api-key");
	if (type === "oauth" && !oauth) throw new Error(`${provider.name} does not offer OAuth; use api-key`);
	if (type === "api_key" && !apiKey?.login)
		throw new Error(`${provider.name} does not offer interactive API-key setup`);
	try {
		await loginProvider(models, providerId, type, interactionFrom(asker, signal), { getDeviceId: deviceId });
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.message === "login cancelled")) return undefined;
		// Provider errors may contain credentials, callback URLs or raw server responses.
		throw new Error(
			`login failed for ${providerId}; check your credentials, browser authorization and local auth store`,
		);
	}
	asker.say(`Signed in to ${providerId}.`);
	return providerId;
}

export async function signOut(models: MutableModels, providerId: string | undefined, say: Asker["say"]): Promise<void> {
	if (!providerId) throw new Error("specify a provider: /logout <provider> or bedrock logout <provider>");
	await logoutProvider(models, providerId);
	say(`Removed saved credentials for ${providerId}. Environment credentials, if set, still apply.`);
}
