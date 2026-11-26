import {
	configuredProviders,
	FileCredentialStore,
	hasUnknownPricing,
	parseModelRef,
	refreshModelCatalog,
} from "@bedrock/ai";
import type { MissionApp } from "@bedrock/tui";
import type { MutableModels } from "@earendil-works/pi-ai";
import { type Asker, showProviders, signIn, signOut } from "./login.ts";
import { assertExternalAuth } from "./runtime.ts";
import { saveModel } from "./settings.ts";

export function tuiAccount(
	app: MissionApp,
	models: MutableModels,
	selection: { current: () => string | undefined; select: (model?: string) => void },
) {
	let pending: AbortController | undefined;
	const asker: Asker = {
		ask: (question, signal) => app.ask(question, undefined, signal),
		askSecret: (question, signal) => app.askSecret(question, signal),
		select: (title, items, signal) => app.choose(title, items, signal),
		say: (text) => app.note(text),
	};
	return {
		get pending() {
			return pending !== undefined;
		},
		cancel: () => pending?.abort(),
		command(command: string, args: string): boolean {
			if (!["login", "logout", "providers", "model"].includes(command)) return false;
			if (pending || app.view.busy) {
				app.note(`/${command} is available when idle`);
				return true;
			}
			const [provider, method] = args.trim().split(/\s+/);
			const controller = new AbortController();
			pending = controller;
			app.setBusy(true, `/${command} · Esc cancels`);
			const run = async () => {
				if (command === "login") {
					assertExternalAuth(process.cwd());
					if (!(await signIn(models, asker, provider, method, controller.signal))) app.note("Login cancelled.");
				} else if (command === "logout") {
					const stored = provider ? [] : await new FileCredentialStore().list();
					if (!provider && !stored.length) {
						app.note("No saved credentials to remove.");
						return;
					}
					const selected =
						provider ||
						(await app.choose(
							"Sign out · remove saved credentials",
							stored.map(({ providerId, type }) => ({
								value: providerId,
								label: providerId,
								description: type,
							})),
							controller.signal,
						));
					if (selected) await signOut(models, selected, asker.say);
				} else if (command === "providers") {
					const lines: string[] = [];
					await showProviders(models, (line) => lines.push(line), provider || "");
					if (!controller.signal.aborted) app.showPanel("PROVIDERS", lines);
				} else {
					const signal = controller.signal;
					let selected: string | undefined = args;
					const discovery = { signal, note: asker.say };
					if (args !== "auto" && !args.includes("/")) {
						await refreshModelCatalog(models, { ...discovery, providers: provider ? [provider] : undefined });
						const ids = provider ? [provider] : await configuredProviders(models);
						const available = (await Promise.all(ids.map((id) => models.getAvailable(id, { signal })))).flat();
						if (!available.length)
							app.note("No available models for this filter. Use /login to connect a provider.");
						selected = await app.choose(
							`Worker model · ${selection.current() ?? "auto"}`,
							[
								{ value: "auto", label: "Automatic", description: "Clear the saved preference" },
								...available.map((model) => ({
									value: `${model.provider}/${model.id}`,
									label: `${model.provider}/${model.id}`,
									description: hasUnknownPricing(model) ? `${model.name} · pricing unknown` : model.name,
								})),
							],
							signal,
						);
					}
					if (!selected || signal.aborted) return;
					if (selected === "auto") {
						saveModel();
						selection.select();
						app.note("Cleared the saved worker model; using configured or available defaults.");
					} else {
						const { provider: providerId, id } = parseModelRef(selected);
						if (args.includes("/")) await refreshModelCatalog(models, { ...discovery, providers: [providerId] });
						if (!models.getModel(providerId, id))
							throw new Error("Model not in the catalog. Use /model to browse.");
						if (!(await models.getAvailable(providerId, { signal })).some((model) => model.id === id))
							throw new Error("Model is not available with current credentials. Use /login first.");
						saveModel(selected);
						selection.select(selected);
						app.note(`Worker model saved: ${selected}.`);
					}
				}
			};
			void run()
				.catch((error: Error) => {
					if (!controller.signal.aborted) app.note(error.message);
				})
				.finally(() => {
					pending = undefined;
					app.setBusy(false, "ready · /help");
				});
			return true;
		},
	};
}
