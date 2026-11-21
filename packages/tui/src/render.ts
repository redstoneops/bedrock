// @bedrock/tui: Mission Control rendering on pi-tui primitives.
//
// Rendering is a pure function of the view, the width and the height. Every line
// is clipped with pi-tui's ANSI-aware `truncateToWidth`, so colors and wide
// characters never break the layout. Assistant text goes through pi-tui's
// Markdown component, cached per message so streaming re-renders stay cheap.

import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ConversationLine, MissionView } from "./view.ts";

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const ITALIC = "\u001b[3m";
const UNDERLINE = "\u001b[4m";
const STRIKE = "\u001b[9m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const BLUE = "\u001b[34m";
const MAGENTA = "\u001b[35m";
const CYAN = "\u001b[36m";
const GRAY = "\u001b[90m";

/** Wraps text in an SGR color and resets it. */
export function paint(text: string, color: string): string {
	return `${color}${text}${RESET}`;
}

/** The Markdown theme for assistant messages. */
export const MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => paint(text, `${BOLD}${CYAN}`),
	link: (text) => paint(text, `${UNDERLINE}${BLUE}`),
	linkUrl: (text) => paint(text, GRAY),
	code: (text) => paint(text, YELLOW),
	codeBlock: (text) => paint(text, GREEN),
	codeBlockBorder: (text) => paint(text, GRAY),
	quote: (text) => paint(text, ITALIC),
	quoteBorder: (text) => paint(text, GRAY),
	hr: (text) => paint(text, GRAY),
	listBullet: (text) => paint(text, CYAN),
	bold: (text) => paint(text, BOLD),
	italic: (text) => paint(text, ITALIC),
	strikethrough: (text) => paint(text, STRIKE),
	underline: (text) => paint(text, UNDERLINE),
};

/** Pads or clips to exactly `width` visible columns. */
export function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	const pad = Math.max(0, width - visibleWidth(clipped));
	return `${clipped}${" ".repeat(pad)}`;
}

function money(value: number): string {
	return `$${value.toFixed(2)}`;
}

function duration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${seconds}s`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The header: spinner, mission, phase, budget, elapsed time. */
export function renderHeader(view: MissionView, width: number, now = Date.now()): string {
	const spin = view.busy
		? paint(SPINNER[Math.floor(now / 100) % SPINNER.length] ?? "·", CYAN)
		: paint("■", view.proof?.finalState === "passed" ? GREEN : GRAY);
	const budget = view.budgetUsd ? `${money(view.costUsd)} / ${money(view.budgetUsd)}` : money(view.costUsd);
	const phase = view.layout === "chat" ? "quick" : view.phase;
	const left = `${spin} ${paint("Bedrock", BOLD)} ${DIM}·${RESET} ${phase} ${DIM}·${RESET} ${view.goal || paint("no mission yet", DIM)}`;
	const right = `${budget} ${DIM}·${RESET} ${view.busy || view.proof ? duration(view.elapsedMs(now)) : "--"}`;
	const leftWidth = Math.max(10, width - visibleWidth(right) - 2);
	return `${fit(left, leftWidth)}  ${right}`;
}

const STATUS_ICON: Record<string, string> = {
	passed: paint("✓", GREEN),
	failed: paint("✗", RED),
	running: paint("◐", YELLOW),
	planned: paint("·", DIM),
	pruned: paint("✗", DIM),
	abandoned: paint("·", DIM),
};

/** The strategy tree, with status per branch. */
export function renderStrategy(view: MissionView, width: number): string[] {
	const lines: string[] = [paint("STRATEGY", BOLD)];
	const nodes = view.strategy.nodes;
	const root = nodes[view.strategy.rootId];
	if (!root) {
		lines.push(paint("  (no plan yet)", DIM));
		return lines.map((line) => fit(line, width));
	}
	lines.push(`  ${STATUS_ICON[root.status] ?? "·"} ${root.title}`);
	for (const [index, id] of (root.children ?? []).entries()) {
		const node = nodes[id];
		if (!node) continue;
		const branch = index === root.children.length - 1 ? "└─" : "├─";
		lines.push(`  ${branch} ${STATUS_ICON[node.status] ?? "·"} ${node.title}`);
	}
	return lines.map((line) => fit(line, width));
}

/** The gate panel: every check with status, holdout locked. */
export function renderGate(view: MissionView, width: number): string[] {
	const passed = view.gate.filter((row) => row.status === "passed").length;
	const lines = [paint(`GATE ${passed}/${view.gate.length}`, BOLD)];
	if (view.gate.length === 0) lines.push(paint("  (not verified yet)", DIM));
	for (const row of view.gate.slice(0, 14)) {
		const label = row.holdout ? `${row.name} ${paint("🔒", DIM)}` : row.name;
		const time = row.durationMs !== undefined ? paint(` ${(row.durationMs / 1000).toFixed(1)}s`, DIM) : "";
		if (row.status === "passed") lines.push(`  ${paint("✓", GREEN)} ${label}${time}`);
		else if (row.status === "failed") lines.push(`  ${paint("✗", RED)} ${label}${time}`);
		else if (row.status === "error") lines.push(`  ${paint("!", YELLOW)} ${label}${time}`);
		else lines.push(`  ${paint("·", DIM)} ${label}`);
	}
	if (view.gate.length > 14) lines.push(paint(`  +${view.gate.length - 14} more`, DIM));
	if (view.gate.some((row) => row.holdout && row.status === "not_run"))
		lines.push(paint("  🔒 holdout runs only at verification", DIM));
	else if (view.gate.length > 0 && !view.gate.some((row) => row.holdout))
		lines.push(paint("  no holdout checks", DIM));
	return lines.map((line) => fit(line, width));
}

const markdownCache = new WeakMap<ConversationLine, { markdown: Markdown; text: string }>();

function renderMarkdown(line: ConversationLine, width: number): string[] {
	let cached = markdownCache.get(line);
	if (!cached) {
		cached = { markdown: new Markdown(line.text, 0, 0, MARKDOWN_THEME), text: line.text };
		markdownCache.set(line, cached);
	} else if (cached.text !== line.text) {
		cached.markdown.setText(line.text);
		cached.text = line.text;
	}
	return cached.markdown.render(Math.max(10, width));
}

/** Renders one transcript entry. */
function renderLine(line: ConversationLine, width: number): string[] {
	switch (line.kind) {
		case "text":
			return line.text.trim().length === 0 ? [] : [...renderMarkdown(line, width), ""];
		case "tool": {
			const card = line.card;
			const status =
				card?.status === "running"
					? paint("…", YELLOW)
					: card?.status === "ok"
						? paint("✓", GREEN)
						: paint("✗", RED);
			const meta: string[] = [];
			if (card?.diffStat)
				meta.push(`${paint(`+${card.diffStat.additions}`, GREEN)} ${paint(`-${card.diffStat.deletions}`, RED)}`);
			if (card?.exitCode !== undefined)
				meta.push(card.exitCode === 0 ? paint("exit 0", DIM) : paint(`exit ${card.exitCode}`, RED));
			if (card?.durationMs !== undefined && card.durationMs >= 1000)
				meta.push(paint(`${(card.durationMs / 1000).toFixed(1)}s`, DIM));
			const out = [`${status} ${paint(line.text, CYAN)} ${meta.join(" ")}`];
			if (card?.status === "error" && card.head) {
				for (const row of card.head.split("\n").slice(0, 3)) out.push(paint(`    ${row}`, DIM));
			} else if (card?.head && card.status !== "running") {
				const first = card.head.split("\n").find((row) => row.trim().length > 0 && !row.startsWith("¶"));
				if (first) out.push(paint(`    ${first}`, GRAY));
			}
			return out;
		}
		case "advisor": {
			const color = line.tag === "blocker" ? RED : line.tag === "concern" ? YELLOW : MAGENTA;
			return wrap(`advisor ${line.tag}: ${line.text}`, width - 2).map((row) => paint(`  ${row}`, color));
		}
		case "verification":
			return [paint(`▶ ${line.text}`, `${BOLD}${BLUE}`)];
		default:
			return wrap(line.text, width - 2).map((row) => paint(`  ${row}`, GRAY));
	}
}

/** The conversation and tool cards, newest at the bottom, clipped to `height`. */
export function renderConversation(view: MissionView, width: number, height: number): string[] {
	const out: string[] = [];
	// Render from the end until the pane is full: long missions stay O(visible lines).
	for (let index = view.conversation.length - 1; index >= 0 && out.length < height; index--) {
		out.unshift(...renderLine(view.conversation[index], width));
	}
	if (view.conversation.length === 0)
		out.push(paint("  Describe the task. Bedrock will compile a gate, then work until it passes.", DIM));
	return out.slice(-height).map((line) => fit(line, width));
}

/** Ledger strip: counts a reader scans for "is this grounded?". */
export function renderLedger(view: MissionView, width: number): string {
	const parts = [
		`facts ${view.ledger.byKind.fact}`,
		`hyp ${view.ledger.openHypotheses} open`,
		`evidence ${view.ledger.byKind.evidence}`,
		`risks ${view.ledger.risks}`,
	];
	const budget = view.budgetAction ? ` · next: ${view.budgetAction.action}` : "";
	return fit(paint(`LEDGER  ${parts.join(" · ")}${budget}`, DIM), width);
}

/** The ledger pane, when expanded. */
export function renderLedgerPane(view: MissionView, width: number): string[] {
	const lines = [paint("LEDGER (latest)", BOLD)];
	if (view.recentLedger.length === 0) lines.push(paint("  (empty)", DIM));
	for (const entry of view.recentLedger.slice(-10)) lines.push(`  ${entry}`);
	return lines.map((line) => fit(line, width));
}

/** The agent hub, when expanded. */
export function renderAgents(view: MissionView, width: number): string[] {
	const lines = [paint("AGENTS", BOLD)];
	if (view.workers.size === 0) lines.push(paint("  (none)", DIM));
	for (const worker of view.workers.values()) {
		const icon =
			worker.status === "passed"
				? paint("✓", GREEN)
				: worker.status === "failed" || worker.status === "crashed"
					? paint("✗", RED)
					: paint("◐", YELLOW);
		lines.push(`  ${icon} ${worker.id.slice(0, 10)} ${worker.status} · ${worker.turns} turns`);
	}
	return lines.map((line) => fit(line, width));
}

/** The plain input line, for surfaces without pi-tui's Editor (tests, dumb terminals). */
export function renderInput(view: MissionView, width: number): string {
	const prompt = paint(view.question ? "? " : "> ", BOLD);
	const hint = paint(" [Enter] send  [Esc] interrupt  [Ctrl+K] agents  [Ctrl+L] ledger", DIM);
	const room = Math.max(8, width - visibleWidth(hint));
	return `${fit(`${prompt}${view.steering}`, room)}${hint}`;
}

/** The proof of work, as the last screen of a mission. */
export function renderProof(view: MissionView, width: number): string[] {
	if (!view.proof) return [];
	const proof = view.proof;
	const stateColor = proof.finalState === "passed" ? GREEN : proof.finalState === "partial" ? YELLOW : RED;
	const lines = [
		paint(`PROOF OF WORK — ${proof.finalState.toUpperCase()}`, `${BOLD}${stateColor}`),
		proof.summary,
		"",
		`diff: ${proof.diffStat.files} files, ${paint(`+${proof.diffStat.additions}`, GREEN)} ${paint(`-${proof.diffStat.deletions}`, RED)}`,
		`cost: ${money(proof.cost.usd)} · ${proof.cost.tokens} tokens · ${duration(proof.cost.wallClockMs)}`,
	];
	if (proof.gate) {
		lines.push(
			`gate: ${proof.gate.visible.filter((run) => run.status === "passed").length}/${proof.gate.visible.length} visible, ${proof.gate.holdout.filter((run) => run.status === "passed").length}/${proof.gate.holdout.length} holdout · tree ${proof.gate.treeHash.slice(0, 12)}`,
		);
		for (const run of proof.gate.visible.filter((item) => item.status !== "passed"))
			lines.push(paint(`  ✗ ${run.name}: ${run.failureReason ?? run.status}`, RED));
	}
	if (proof.unverified.length > 0)
		lines.push(paint("unverified:", YELLOW), ...proof.unverified.map((item) => `- ${item}`));
	if (proof.risks.length > 0) lines.push(paint("risks:", YELLOW), ...proof.risks.map((item) => `- ${item}`));
	if (proof.checkpoints.length > 0)
		lines.push(paint("branches kept:", DIM), ...proof.checkpoints.map((item) => `- ${item.label}`));
	return lines.flatMap((line) => wrap(line, width)).map((line) => fit(line, width));
}

export interface RenderOptions {
	/** Include the plain input line (false when pi-tui's Editor renders below). */
	input?: boolean;
	now?: number;
}

/** The whole screen: header, status, panes, ledger strip and (optionally) input. */
export function renderMission(view: MissionView, width: number, height: number, options: RenderOptions = {}): string[] {
	const withInput = options.input !== false;
	const header = renderHeader(view, width, options.now);
	const status = fit(
		paint(view.question ? `question: ${view.question}` : view.status, view.question ? YELLOW : DIM),
		width,
	);
	const chrome = 3 + (withInput ? 1 : 0);
	const bodyHeight = Math.max(3, height - chrome);
	const body: string[] = [];
	if (view.proof && view.layout === "mission") {
		const proof = renderProof(view, width);
		const conversation = renderConversation(view, width, Math.max(0, bodyHeight - proof.length - 1));
		body.push(
			...conversation,
			...(conversation.length > 0 ? [fit(paint("─".repeat(width), GRAY), width)] : []),
			...proof,
		);
	} else if (view.layout === "chat" || width < 76) {
		const extra = view.layout === "mission" ? [...renderStrategy(view, width), ...renderGate(view, width)] : [];
		const conversation = renderConversation(view, width, Math.max(1, bodyHeight - extra.length));
		body.push(...extra, ...conversation);
	} else {
		const leftWidth = Math.max(28, Math.floor(width * 0.34));
		const rightWidth = width - leftWidth - 1;
		const left = [...renderStrategy(view, leftWidth), "", ...renderGate(view, leftWidth)];
		if (view.expanded === "agents") left.push("", ...renderAgents(view, leftWidth));
		if (view.expanded === "ledger") left.push("", ...renderLedgerPane(view, leftWidth));
		const conversation = renderConversation(view, rightWidth, bodyHeight);
		const pad = bodyHeight - conversation.length;
		for (let index = 0; index < bodyHeight; index++) {
			const right = index >= pad ? conversation[index - pad] : "";
			body.push(`${fit(left[index] ?? "", leftWidth)}${paint("│", GRAY)}${right ?? ""}`);
		}
	}
	while (body.length < bodyHeight) body.unshift("");
	const lines = [header, status, ...body.slice(-bodyHeight), renderLedger(view, width)];
	if (withInput) lines.push(renderInput(view, width));
	return lines.map((line) => fit(line, width));
}

/** Wraps text to `width` columns, preserving explicit newlines. */
export function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	const limit = Math.max(4, width);
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		for (const word of paragraph.split(" ")) {
			const candidate = current.length === 0 ? word : `${current} ${word}`;
			if (visibleWidth(candidate) > limit && current.length > 0) {
				lines.push(current);
				current = word;
			} else {
				current = candidate;
			}
		}
		if (current.length > 0) lines.push(current);
	}
	return lines;
}

/** A pi-tui component that renders the cockpit for a fixed height source. */
export class MissionControl {
	readonly view: MissionView;
	onSteer?: (text: string) => void;
	onInterrupt?: () => void;
	/** Rows available to the cockpit; the app wires this to the terminal size. */
	rows: () => number = () => 30;
	/** Whether the cockpit renders its own input line. */
	input = true;

	constructor(view = new MissionView()) {
		this.view = view;
	}

	render(width: number, height = this.rows()): string[] {
		return renderMission(this.view, width, height, { input: this.input });
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const action = this.view.handleInput(data);
		if (action === "submit") {
			const text = this.view.submitSteering();
			if (text) this.onSteer?.(text);
		} else if (action === "interrupt") {
			this.view.interrupted = true;
			this.onInterrupt?.();
		} else if (action === "toggle-ledger") {
			this.view.expanded = this.view.expanded === "ledger" ? "none" : "ledger";
		} else if (action === "toggle-agents") {
			this.view.expanded = this.view.expanded === "agents" ? "none" : "agents";
		}
	}
}
