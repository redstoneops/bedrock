import type { MissionApp } from "@bedrock/tui";
import type { MutableModels } from "@earendil-works/pi-ai";
import { type Asker, showProviders, signIn, signOut } from "./login.ts";

export function tuiAccount(app: MissionApp, models: MutableModels) {
	let pending: AbortController | undefined;
	const asker: Asker = {
		ask: (question, signal) => app.ask(question, undefined, signal),
		askSecret: (question, signal) => app.askSecret(question, signal),
		say: (text) => app.note(text),
	};
	return {
		get pending() {
			return pending !== undefined;
		},
		cancel: () => pending?.abort(),
		command(command: string, args: string): boolean {
			if (!["login", "logout", "providers"].includes(command)) return false;
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
					if (!(await signIn(models, asker, provider, method, controller.signal))) app.note("Login cancelled.");
				} else if (command === "logout") {
					await signOut(models, provider, asker.say);
				} else {
					await showProviders(models, asker.say, provider || "");
				}
			};
			void run()
				.catch((error: Error) => app.note(error.message))
				.finally(() => {
					pending = undefined;
					app.setBusy(false, "ready · /help");
				});
			return true;
		},
	};
}
