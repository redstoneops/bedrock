// @bedrock/tui: the interactive Mission Control application.
//
// pi-tui owns the terminal: differential rendering means a streaming token only
// rewrites the lines that changed, and its Editor gives real line editing,
// history and paste handling. Bedrock owns the layout (the cockpit component)
// and the key bindings. The app never touches missions directly: surfaces feed
// it events and receive submissions, steering and interrupts through callbacks.

import type { BedrockEvent } from "@bedrock/protocol";
import {
	Editor,
	type EditorTheme,
	matchesKey,
	ProcessTerminal,
	type Terminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
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

export const SLASH_HELP = [
	"/help            this help",
	"/agents          toggle the agent hub (Ctrl+K)",
	"/ledger          toggle the ledger pane (Ctrl+L)",
	"/gate            list the gate checks and their status",
	"/proof           show where the proof of work was written",
	"/clear           clear the transcript",
	"/quit            leave (Ctrl+C twice)",
	"Esc interrupts the running mission; typing while it runs steers the workers.",
];

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
	#lastCtrlC = 0;
	#started = false;

	constructor(options: MissionAppOptions = {}) {
		this.#options = options;
		this.view = new MissionView();
		this.view.layout = options.layout ?? "mission";
		this.view.status = this.view.layout === "chat" ? "quick mode: ask for a change" : "describe a mission to start";
		this.terminal = options.terminal ?? new ProcessTerminal();
		this.tui = new TuiMainScreen(this.terminal);
		this.cockpit = new MissionControl(this.view);
		this.cockpit.input = false;
		this.editor = new Editor(this.tui, EDITOR_THEME, { paddingX: 1 });
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

	setBusy(busy: boolean, status?: string): void {
		this.view.busy = busy;
		if (busy) this.view.startedAt = Date.now();
		if (status !== undefined) this.view.status = status;
		this.tui.requestRender();
	}

	/** Shows a question and resolves with the next submission (Esc resolves undefined). */
	ask(question: string, options?: string[]): Promise<string | undefined> {
		this.view.question = options?.length ? `${question} [${options.join(" / ")}]` : question;
		this.view.note(`question: ${this.view.question}`, "advisor");
		this.tui.requestRender();
		return new Promise((resolve) => {
			this.#answer = (text) => {
				this.view.question = undefined;
				this.#answer = undefined;
				resolve(text);
			};
		});
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		this.editor.setText("");
		if (trimmed.length === 0) return;
		this.editor.addToHistory(trimmed);
		if (this.#answer) {
			this.view.note(`you: ${trimmed}`);
			this.#answer(trimmed);
			return;
		}
		if (trimmed.startsWith("/")) {
			const [command, ...rest] = trimmed.slice(1).split(" ");
			this.#command(command ?? "", rest.join(" "));
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
				for (const line of SLASH_HELP) this.view.note(line);
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
