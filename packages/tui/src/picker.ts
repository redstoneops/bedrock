// Searchable dropdown using pi-tui's scrolling and selection behavior.

import {
	decodeKittyPrintable,
	matchesKey,
	type SelectItem,
	SelectList,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { fit, paint } from "./render.ts";

const theme = {
	selectedPrefix: (text: string) => paint(text, "\x1b[36m"),
	selectedText: (text: string) => paint(text, "\x1b[1;36m"),
	description: (text: string) => paint(text, "\x1b[90m"),
	scrollInfo: (text: string) => paint(text, "\x1b[90m"),
	noMatch: () => paint("  No matching options", "\x1b[90m"),
};

export class Picker {
	readonly capturesViewportInput = true;
	#query = "";
	#list: SelectList;
	#title: string;
	#items: SelectItem[];
	#onPick: (value?: string) => void;
	#rows: number;

	constructor(title: string, items: readonly SelectItem[], rows: number, onPick: (value?: string) => void) {
		this.#title = title;
		this.#items = [...items];
		this.#rows = rows;
		this.#onPick = onPick;
		this.#list = this.#filteredList();
	}

	#filteredList(): SelectList {
		const query = this.#query.toLowerCase().trim();
		const matches = this.#items.filter(({ value, label, description }) =>
			`${value} ${label} ${description ?? ""}`.toLowerCase().includes(query),
		);
		const list = new SelectList(matches, this.#rows, theme, { maxPrimaryColumnWidth: 46 });
		list.onSelect = (item) => this.#onPick(item.value);
		list.onCancel = () => this.#onPick();
		return list;
	}

	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		return [
			paint(`╭${fit(` ${this.#title} `, inner).trimEnd().padEnd(inner, "─")}╮`, "\x1b[36m"),
			`│${fit(` Filter: ${this.#query || "type to search"}`, inner)}│`,
			...this.#list.render(inner).map((line) => `│${fit(line, inner)}│`),
			`│${fit(" ↑/↓ move · Enter select · Esc close", inner)}│`,
			paint(`╰${"─".repeat(inner)}╯`, "\x1b[36m"),
		].map((line) => fit(line, width));
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) this.#onPick();
		else if (matchesKey(data, "backspace")) {
			this.#query = Array.from(this.#query).slice(0, -1).join("");
			this.#list = this.#filteredList();
		} else {
			const text = decodeKittyPrintable(data) ?? data.replace(/^\x1b\[200~|\x1b\[201~$/g, "");
			if (text && !/[\x00-\x1f\x7f-\x9f]/.test(text)) {
				this.#query = (this.#query + text).slice(0, 120);
				this.#list = this.#filteredList();
			} else this.#list.handleInput(data);
		}
	}

	handleMouse(event: TuiMouseEvent) {
		return this.#list.handleMouse({ ...event, y: event.y - 2 });
	}
}
