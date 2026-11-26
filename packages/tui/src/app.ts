// @bedrock/tui: the interactive Mission Control application.
//
// pi-tui owns the terminal: differential rendering means a streaming token only
// rewrites the lines that changed, and its Editor gives real line editing,
// history and paste handling. Bedrock owns the layout (the cockpit component)
// and the key bindings. The app never touches missions directly: surfaces feed
// it events and receive submissions, steering and interrupts through callbacks.

import type { BedrockEvent } from "@bedrock/protocol";
import {
	CombinedAutocompleteProvider,
	decodeKittyPrintable,
	Editor,
	type EditorTheme,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	type Terminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { SLASH_COMMANDS, SLASH_HELP } from "./commands.ts";
import { Picker } from "./picker.ts";
import { MissionControl, paint } from "./render.ts";
import { MissionView } from "./view.ts";

const GRAY = "\u001b[90m";
const CYAN = "\u001b[36m";

const EDITOR_THEME: EditorTheme = {
	borderColor: (text) => paint(text, GRAY),
	selectList: {
		selectedPrefix: (text) => paint(text, CYAN),
		selectedText: (text) => paint(text, CYAN),
		description: (text) => paint(text, GRAY),
		scrollInfo: (text) => paint(text, GRAY),
		noMatch: (text) => paint(text, GRAY),
	},
};

export { SLASH_HELP } from "./commands.ts";

export interface MissionAppOptions {
	/** Terminal to draw on; defaults to the process terminal. Tests pass a virtual one. */
	terminal?: Terminal;
	layout?: "mission" | "chat";
	/** A submission that is not a slash command and not an answer to a question. */
	onSubmit?: (text: string) => void;
	/** Esc while busy. */
	onInterrupt?: () => void;
	/** The user asked to leave. */
	onQuit?: () => void;
	/** Extra slash commands owned by the surface; return true when handled. */
	onCommand?: (command: string, args: string) => boolean;
	/** Ticks the clock and spinner; 0 disables (tests). */
	tickMs?: number;
}

/** Mission Control on a terminal. */
export class MissionApp {
	readonly view: MissionView;
	readonly terminal: Terminal;
	readonly tui: TuiMainScreen;
	readonly cockpit: MissionControl;
	readonly editor: Editor;
	#options: MissionAppOptions;
	#ticker?: ReturnType<typeof setInterval>;
	#answer?: (text: string | undefined) => void;
	#secret?: string;
	#closePicker?: () => void;
	#lastCtrlC = 0;
	#started = false;

	constructor(options: MissionAppOptions = {}) {
		this.#options = options;
		this.view = new MissionView();
		this.view.layout = options.layout ?? "mission";
		this.view.status =
			this.view.layout === "chat"
				? "quick mode: ask for a change · Ctrl+P commands"
				: "describe a mission to start · /login · Ctrl+P commands";
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.tui = new TuiMainScreen(this.terminal);
		this.cockpit = new MissionControl(this.view);
		this.cockpit.input = false;
		this.editor = new Editor(this.tui, EDITOR_THEME, { paddingX: 1 });
		const commands = new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd(), null);
		this.editor.setAutocompleteProvider({
			triggerCharacters: ["/"],
			getSuggestions: (lines, row, col, options) =>
				row === 0 && lines[0]?.slice(0, col).startsWith("/")
					? commands.getSuggestions(lines, row, col, options)
					: Promise.resolve(null),
			applyCompletion: (...args) => commands.applyCompletion(...args),
		});
		this.editor.onSubmit = (text) => this.#submit(text);
		// The cockpit fills the screen above the editor (3 rows: border, line, border).
		this.cockpit.rows = () => Math.max(8, this.terminal.rows - 3);
		this.tui.addChild(this.cockpit);
		this.tui.addChild(this.editor);
		this.tui.setFocus(this.editor);
		this.tui.addInputListener((data) => this.#globalKey(data));
	}

	/** Takes over the terminal. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.tui.start();
		const tick = this.#options.tickMs ?? 250;
		if (tick > 0) {
			this.#ticker = setInterval(() => {
				if (this.view.busy) this.tui.requestRender();
			}, tick);
			this.#ticker.unref?.();
		}
		this.tui.requestRender();
	}

	/** Restores the terminal. The final screen stays in the scrollback. */
	stop(): void {
		if (!this.#started) return;
		this.#started = false;
		this.#closePicker?.();
		this.#answer?.(undefined);
		if (this.#ticker) clearInterval(this.#ticker);
		this.tui.stop();
	}

	/** Feeds one protocol event into the view and schedules a render. */
	apply(event: BedrockEvent): void {
		if (event.type === "mission_start") this.view.reset();
		this.view.apply(event);
		this.tui.requestRender();
	}

	/** Adds a local line and renders. */
	note(text: string): void {
		this.view.note(text);
		this.tui.requestRender();
	}

	setCost(usd: number, budgetUsd?: number): void {
		this.view.costUsd = usd;
		if (budgetUsd !== undefined) this.view.budgetUsd = budgetUsd;
	}

	/** Shows longer command output without truncating the transcript. */
	showPanel(title: string, lines: string[]): void {
		this.view.panel = { title, lines, offset: 0 };
		this.tui.requestRender();
	}

	/** Opens a searchable picker without putting the typed filter into the editor history. */
	choose(title: string, items: readonly SelectItem[], signal?: AbortSignal): Promise<string | undefined> {
		if (signal?.aborted || this.#answer || this.#closePicker) return Promise.resolve(undefined);
		this.view.panel = undefined;
		return new Promise((resolve) => {
			const close = (value?: string) => {
				signal?.removeEventListener("abort", cancel);
				this.#closePicker = undefined;
				overlay.hide();
				resolve(value);
			};
			const cancel = () => close();
			const picker = new Picker(title, items, Math.max(1, Math.min(10, this.terminal.rows - 7)), close);
			const overlay = this.tui.showOverlay(picker, { width: "85%", maxHeight: "95%", anchor: "center" });
			this.#closePicker = cancel;
			signal?.addEventListener("abort", cancel, { once: true });
		});
	}

	setBusy(busy: boolean, status?: string): void {
		this.view.busy = busy;
		if (busy) this.view.startedAt = Date.now();
		if (status !== undefined) this.view.status = status;
		this.tui.requestRender();
	}

	/** Shows a question and resolves with the next submission (Esc resolves undefined). */
	ask(question: string, options?: string[], signal?: AbortSignal): Promise<string | undefined> {
		return this.#ask(question, options, false, signal);
	}

	/** Keeps sensitive input out of the Editor, its history and the transcript. */
	askSecret(question: string, signal?: AbortSignal): Promise<string | undefined> {
		return this.#ask(`${question} (input hidden)`, undefined, true, signal);
	}

	#ask(
		question: string,
		options: string[] | undefined,
		secret: boolean,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		if (signal?.aborted || this.#answer) return Promise.resolve(undefined);
		if (secret) this.#secret = "";
		this.view.panel = undefined;
		this.view.question = options?.length ? `${question} [${options.join(" / ")}]` : question;
		this.view.note(`question: ${this.view.question}`);
		this.tui.requestRender();
		return new Promise((resolve) => {
			const cancel = () => this.#answer?.(undefined);
			this.#answer = (text) => {
				signal?.removeEventListener("abort", cancel);
				this.view.question = undefined;
				this.#secret = undefined;
				this.#answer = undefined;
				this.tui.requestRender();
				resolve(text);
			};
			signal?.addEventListener("abort", cancel, { once: true });
		});
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		this.editor.setText("");
		if (this.#answer) {
			if (this.#secret !== undefined) return;
			this.#answer(trimmed);
			return;
		}
		if (trimmed.length === 0) return;
		this.editor.addToHistory(trimmed);
		if (trimmed.startsWith("/")) {
			const boundary = trimmed.search(/\s/);
			this.#command(
				trimmed.slice(1, boundary < 0 ? undefined : boundary),
				boundary < 0 ? "" : trimmed.slice(boundary).trim(),
			);
			return;
		}
		if (this.view.busy && this.view.layout === "mission") this.view.note(`you (steering): ${trimmed}`);
		this.#options.onSubmit?.(trimmed);
		this.tui.requestRender();
	}

	#command(command: string, args: string): void {
		if (this.#options.onCommand?.(command, args)) {
			this.tui.requestRender();
			return;
		}
		switch (command) {
			case "help":
				this.showPanel("COMMAND PALETTE", SLASH_HELP);
				break;
			case "status":
				this.showPanel("SESSION STATUS", [
					`Mode: ${this.view.layout === "chat" ? "quick (no gate)" : "mission (verified)"}`,
					`State: ${this.view.busy ? "busy" : "idle"} · ${this.view.phase}`,
					`Goal: ${this.view.goal || "not set"}`,
					`Workspace: ${this.view.workspace || "not reported"}`,
					`Workers observed: ${this.view.workers.size}`,
				]);
				break;
			case "cost":
				this.showPanel("COST ESTIMATE", [
					`Estimated spend: $${this.view.costUsd.toFixed(4)}`,
					`Mission budget: ${this.view.budgetUsd === undefined ? "not set" : `$${this.view.budgetUsd.toFixed(2)}`}`,
					"Provider billing and subscription limits may differ.",
				]);
				break;
			case "agents":
				this.view.expanded = this.view.expanded === "agents" ? "none" : "agents";
				break;
			case "ledger":
				this.view.expanded = this.view.expanded === "ledger" ? "none" : "ledger";
				break;
			case "gate":
				if (this.view.gate.length === 0) this.view.note("the gate has not run yet");
				for (const row of this.view.gate)
					this.view.note(`${row.status === "passed" ? "✓" : "✗"} ${row.name}${row.holdout ? " (holdout)" : ""}`);
				break;
			case "clear":
				this.view.conversation = [];
				break;
			case "quit":
			case "exit":
				this.#options.onQuit?.();
				break;
			default:
				this.view.note(`unknown command /${command}; try /help`);
		}
		this.tui.requestRender();
	}

	#globalKey(data: string): { consume?: boolean } | undefined {
		if (this.#closePicker) return undefined;
		if (!this.#answer && matchesKey(data, "ctrl+p")) {
			const commands = SLASH_COMMANDS.map(({ name, description }) => ({
				value: name,
				label: `/${name}`,
				description,
			}));
			void this.choose("Bedrock · commands", [
				...commands,
				{ value: "install-skill", label: "/skills add", description: "Install a local Markdown skill" },
			]).then((command) => {
				if (command === "goal" || command === "install-skill") {
					this.editor.setText(command === "goal" ? "/goal " : "/skills add ");
					this.tui.requestRender();
				} else if (command) this.#command(command, "");
			});
			return { consume: true };
		}
		if (this.view.panel) {
			if (matchesKey(data, "escape")) {
				this.view.panel = undefined;
				this.tui.requestRender();
				return { consume: true };
			}
			const page = Math.max(3, this.terminal.rows - 8);
			const delta = matchesKey(data, "up")
				? -1
				: matchesKey(data, "down")
					? 1
					: matchesKey(data, "pageUp")
						? -page
						: matchesKey(data, "pageDown")
							? page
							: 0;
			if (delta !== 0) {
				const max = Math.max(0, this.view.panel.lines.length - page);
				this.view.panel.offset = Math.max(0, Math.min(max, this.view.panel.offset + delta));
				this.tui.requestRender();
				return { consume: true };
			}
			// Leave the panel when the user starts another command or prompt.
			this.view.panel = undefined;
			this.tui.requestRender();
		}
		if (this.#secret !== undefined) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.#answer?.(undefined);
			else if (matchesKey(data, "enter")) this.#answer?.(this.#secret);
			else if (matchesKey(data, "backspace")) this.#secret = Array.from(this.#secret).slice(0, -1).join("");
			else {
				const text = decodeKittyPrintable(data) ?? data.replace(/^\x1b\[200~|\x1b\[201~$/g, "");
				if (!/[\x00-\x1f\x7f-\x9f]/.test(text)) this.#secret += text;
			}
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			if (this.#answer) {
				this.#answer(undefined);
				return { consume: true };
			}
			if (this.view.busy) {
				this.view.note("interrupting… (the mission stops after the current step)");
				this.#options.onInterrupt?.();
				this.tui.requestRender();
				return { consume: true };
			}
			return undefined;
		}
		if (matchesKey(data, "ctrl+c")) {
			if (this.#answer) {
				this.#answer(undefined);
				return { consume: true };
			}
			const now = Date.now();
			if (now - this.#lastCtrlC < 1500 || !this.view.busy) {
				this.#options.onQuit?.();
			} else {
				this.#lastCtrlC = now;
				this.view.note("press Ctrl+C again to quit; Esc interrupts the mission");
				this.#options.onInterrupt?.();
				this.tui.requestRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+k")) {
			this.view.expanded = this.view.expanded === "agents" ? "none" : "agents";
			this.tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+l")) {
			this.view.expanded = this.view.expanded === "ledger" ? "none" : "ledger";
			this.tui.requestRender();
			return { consume: true };
		}
		return undefined;
	}
}
