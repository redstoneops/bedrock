// @bedrock/tui: an in-memory terminal for tests and headless snapshots.
//
// It implements pi-tui's Terminal interface, records every write, and replays
// the stream into a simple screen buffer that understands the sequences pi-tui
// emits for differential rendering (cursor moves, line clears, CR/LF). That is
// enough to assert what a user would actually see, without a real TTY.

import type { Terminal } from "@earendil-works/pi-tui";

export class VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	#columns: number;
	#rows: number;
	#onInput?: (data: string) => void;
	#onResize?: () => void;
	#screen: string[] = [];
	#row = 0;
	#col = 0;

	constructor(columns = 100, rows = 30) {
		this.#columns = columns;
		this.#rows = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}

	stop(): void {
		this.#onInput = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
		this.#interpret(data);
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(lines: number): void {
		this.#row = Math.max(0, this.#row + lines);
	}

	hideCursor(): void {}
	showCursor(): void {}

	clearLine(): void {
		this.#line(this.#row);
		this.#screen[this.#row] = "";
	}

	clearFromCursor(): void {
		this.#screen.length = Math.min(this.#screen.length, this.#row + 1);
		this.#screen[this.#row] = (this.#screen[this.#row] ?? "").slice(0, this.#col);
	}

	clearScreen(): void {
		this.#screen = [];
		this.#row = 0;
		this.#col = 0;
	}

	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}

	/** Types into the app as if from a keyboard. */
	type(data: string): void {
		this.#onInput?.(data);
	}

	resize(columns: number, rows: number): void {
		this.#columns = columns;
		this.#rows = rows;
		this.#onResize?.();
	}

	/** The visible screen as plain text lines (styles stripped). */
	screen(): string[] {
		return this.#screen.map((line) => line.replace(/\s+$/, ""));
	}

	/** Everything ever written, styles stripped: robust for "did it appear" assertions. */
	transcript(): string {
		return strip(this.writes.join(""));
	}

	#line(row: number): void {
		while (this.#screen.length <= row) this.#screen.push("");
	}

	#interpret(data: string): void {
		let index = 0;
		while (index < data.length) {
			const char = data[index];
			if (char === "\u001b") {
				const rest = data.slice(index);
				const csi = /^\u001b\[([?0-9;:]*)([ -/]*)([@-~])/.exec(rest);
				if (csi) {
					this.#csi(csi[1] ?? "", csi[3] ?? "");
					index += csi[0].length;
					continue;
				}
				const osc = /^\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/.exec(rest);
				if (osc) {
					index += osc[0].length;
					continue;
				}
				index += 2;
				continue;
			}
			if (char === "\r") this.#col = 0;
			else if (char === "\n") {
				this.#row += 1;
				this.#line(this.#row);
			} else {
				this.#line(this.#row);
				const line = this.#screen[this.#row] ?? "";
				const padded = line.length < this.#col ? line + " ".repeat(this.#col - line.length) : line;
				this.#screen[this.#row] = padded.slice(0, this.#col) + char + padded.slice(this.#col + 1);
				this.#col += 1;
			}
			index += 1;
		}
	}

	#csi(params: string, final: string): void {
		const value = Number.parseInt(params.replace("?", ""), 10);
		const n = Number.isNaN(value) ? 1 : value;
		switch (final) {
			case "A":
				this.#row = Math.max(0, this.#row - n);
				break;
			case "B":
				this.#row += n;
				this.#line(this.#row);
				break;
			case "C":
				this.#col += n;
				break;
			case "D":
				this.#col = Math.max(0, this.#col - n);
				break;
			case "G":
				this.#col = Math.max(0, n - 1);
				break;
			case "H": {
				const [row, col] = params.split(";").map((part) => Number.parseInt(part, 10));
				this.#row = Math.max(0, (row || 1) - 1);
				this.#col = Math.max(0, (col || 1) - 1);
				this.#line(this.#row);
				break;
			}
			case "J":
				if (params === "2" || params === "3") this.clearScreen();
				else this.clearFromCursor();
				break;
			case "K":
				this.#line(this.#row);
				this.#screen[this.#row] = params === "2" ? "" : (this.#screen[this.#row] ?? "").slice(0, this.#col);
				break;
			default:
				break;
		}
	}
}

/** Removes ANSI escape sequences. */
export function strip(text: string): string {
	return text
		.replace(/\u001b\[[?0-9;:]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "")
		.replace(/\u001b[^[\]]/g, "");
}
