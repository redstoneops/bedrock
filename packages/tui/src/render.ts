// @bedrock/tui: Mission Control rendering on pi-tui primitives.
//
// Rendering is a pure function of the view and the width. Every line is clipped
// to the viewport with pi-tui's ANSI-aware `truncateToWidth`, so colors and wide
// characters never break the layout at narrow widths.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { MissionView } from "./view.ts";

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const BLUE = "\u001b[34m";
const MAGENTA = "\u001b[35m";
const CYAN = "\u001b[36m";

function paint(text: string, color: string): string {
	return `${color}${text}${RESET}`;
}

/** Pads or clips to exactly `width` visible columns. */
function fit(text: string, width: number): string {
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

const PHASE_LABEL: Record<string, string> = {
	bootstrap: "bootstrap",
	scout: "scout",
	gate: "gate",
	plan: "plan",
	execute: "execute",
	verify: "verify",
	select: "select",
	refine: "refine",
	reflect: "reflect",
	done: "done",
};

/** The header: mission, phase, budget, elapsed time. */
export function renderHeader(view: MissionView, width: number): string {
	const budget = view.budgetUsd ? `${money(view.costUsd)} / ${money(view.budgetUsd)}` : money(view.costUsd);
	const left = `${paint("Bedrock", BOLD)} ${DIM}·${RESET} ${PHASE_LABEL[view.phase] ?? view.phase} ${DIM}·${RESET} ${view.goal}`;
	const right = `${budget} ${DIM}·${RESET} ${duration(view.elapsedMs())}`;
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
	lines.push(fit(`  ${STATUS_ICON[root.status] ?? "·"} ${root.title}`, width));
	for (const [index, id] of (root.children ?? []).entries()) {
		const node = nodes[id];
		if (!node) continue;
		const branch = index === root.children.length - 1 ? "└─" : "├─";
		const icon = STATUS_ICON[node.status] ?? "·";
		lines.push(fit(`  ${branch} ${icon} ${node.title}`, width));
	}
	return lines.map((line) => fit(line, width));
}

/** The gate panel: every check with status, holdout locked. */
export function renderGate(view: MissionView, width: number): string[] {
	const passed = view.gate.filter((row) => row.status === "passed").length;
	const lines = [paint(`GATE ${passed}/${view.gate.length}`, BOLD)];
	if (view.gate.length === 0) lines.push(paint("  (not compiled yet)", DIM));
	for (const row of view.gate.slice(0, 14)) {
		const label = row.holdout ? `${row.name} ${paint("🔒", DIM)}` : row.name;
		if (row.status === "passed") lines.push(fit(`  ${paint("✓", GREEN)} ${label}`, width));
		else if (row.status === "failed") lines.push(fit(`  ${paint("✗", RED)} ${label}`, width));
		else if (row.status === "error") lines.push(fit(`  ${paint("!", YELLOW)} ${label}`, width));
		else lines.push(fit(`  ${paint("·", DIM)} ${label}`, width));
	}
	if (view.gate.length > 14) lines.push(paint(`  +${view.gate.length - 14} more`, DIM));
	if (view.holdoutHidden) lines.push(paint("  holdout runs only at verification", DIM));
	return lines.map((line) => fit(line, width));
}

/** The conversation and tool cards. */
export function renderConversation(view: MissionView, width: number, height: number): string[] {
	const out: string[] = [];
	for (const line of view.conversation.slice(-height)) {
		if (line.kind === "text") {
			out.push(...wrap(line.text, width).map((row) => fit(row, width)));
			out.push(paint("", DIM));
			continue;
		}
		if (line.kind === "tool") {
			const card = line.card;
			const status =
				card?.status === "running"
					? paint("…", YELLOW)
					: card?.status === "ok"
						? paint("✓", GREEN)
						: paint("✗", RED);
			const detail = card?.diffStat
				? `${paint(`+${card.diffStat.additions}`, GREEN)} ${paint(`-${card.diffStat.deletions}`, RED)}`
				: card?.exitCode !== undefined
					? `exit ${card.exitCode}`
					: "";
			out.push(fit(`  ${status} ${paint(line.text, CYAN)} ${DIM}${detail}${RESET}`, width));
			if (card?.head) out.push(fit(`    ${paint(card.head.split("\n")[0] ?? "", DIM)}`, width));
			continue;
		}
		if (line.kind === "advisor") {
			const color = line.tag === "blocker" ? RED : line.tag === "concern" ? YELLOW : MAGENTA;
			out.push(
				...wrap(`advisor ${line.tag}: ${line.text}`, width).map((row) => fit(paint(`  ${row}`, color), width)),
			);
			continue;
		}
		if (line.kind === "verification") out.push(fit(paint(`  ${line.text}`, BLUE), width));
		else out.push(fit(paint(`  ${line.text}`, DIM), width));
	}
	return out;
}

/** Ledger strip: counts a reader scans for "is this grounded?". */
export function renderLedger(view: MissionView, width: number): string {
	const parts = [
		`facts ${view.ledger.byKind.fact}`,
		`hyp ${view.ledger.openHypotheses} open`,
		`evidence ${view.ledger.byKind.evidence}`,
		`risks ${view.ledger.risks}`,
		`unsupported ${Math.round(view.ledger.unsupportedRatio * 100)}%`,
	];
	return fit(paint(`LEDGER  ${parts.join(" · ")}`, DIM), width);
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
		lines.push(fit(`  ${icon} ${worker.status} · ${worker.turns} turns · ${worker.lastAction}`, width));
	}
	return lines.map((line) => fit(line, width));
}

/** The input line, with the key hints the footer advertises. */
export function renderInput(view: MissionView, width: number): string {
	const prompt = paint("> ", BOLD);
	const hint = paint(" [Enter] steer  [Esc] interrupt  [Ctrl+L] ledger  [Ctrl+K] agents", DIM);
	const text = `${prompt}${view.steering}`;
	const room = Math.max(8, width - visibleWidth(hint));
	return `${fit(text, room)}${hint}`;
}

/** The proof of work, as the last screen of a mission. */
export function renderProof(view: MissionView, width: number): string[] {
	if (!view.proof) return [];
	const proof = view.proof;
	const stateColor = proof.finalState === "passed" ? GREEN : proof.finalState === "partial" ? YELLOW : RED;
	const lines = [
		paint(`PROOF OF WORK — ${proof.finalState.toUpperCase()}`, `${BOLD}${stateColor}`),
		fit(proof.summary, width),
		"",
		`diff: ${proof.diffStat.files} files, ${paint(`+${proof.diffStat.additions}`, GREEN)} ${paint(`-${proof.diffStat.deletions}`, RED)}`,
		`cost: ${money(proof.cost.usd)} · ${proof.cost.tokens} tokens · ${duration(proof.cost.wallClockMs)}`,
	];
	if (proof.gate)
		lines.push(
			`gate: ${proof.gate.visible.filter((run) => run.status === "passed").length}/${proof.gate.visible.length} visible, ${proof.gate.holdout.filter((run) => run.status === "passed").length}/${proof.gate.holdout.length} holdout`,
		);
	if (proof.unverified.length > 0)
		lines.push(paint("unverified:", YELLOW), ...proof.unverified.map((item) => `- ${item}`));
	if (proof.risks.length > 0) lines.push(paint("risks:", YELLOW), ...proof.risks.map((item) => `- ${item}`));
	return lines.flatMap((line) => wrap(line, width)).map((line) => fit(line, width));
}

/** The whole screen: header, panes, ledger strip, input. */
export function renderMission(view: MissionView, width: number, height: number): string[] {
	const header = renderHeader(view, width);
	if (view.proof) {
		const proof = renderProof(view, width).slice(0, height - 2);
		return [header, ...proof, renderInput(view, width)];
	}
	const wide = width >= 76;
	const leftWidth = wide ? Math.max(28, Math.floor(width * 0.38)) : width;
	const rightWidth = wide ? width - leftWidth - 1 : width;
	const strategy = renderStrategy(view, leftWidth);
	const gate = renderGate(view, leftWidth);
	const left = [...strategy, "", ...gate];
	if (view.expanded === "agents") left.push("", ...renderAgents(view, leftWidth));
	const bodyHeight = Math.max(4, height - 5);
	const conversation = renderConversation(view, rightWidth, bodyHeight);
	const body: string[] = [];
	for (let index = 0; index < bodyHeight; index++) {
		const leftLine = left[index] ?? "";
		if (wide) body.push(`${fit(leftLine, leftWidth)}│${conversation[index] ?? ""}`);
		else body.push(index < left.length ? fit(leftLine, width) : (conversation[index - left.length] ?? ""));
	}
	const ledger = renderLedger(view, width);
	// One final clip guarantees the invariant for every layout mode.
	return [header, ...body, ledger, renderInput(view, width)].map((line) => fit(line, width));
}

/** Wraps text to `width` columns, preserving explicit newlines. */
export function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		for (const word of paragraph.split(" ")) {
			const candidate = current.length === 0 ? word : `${current} ${word}`;
			if (visibleWidth(candidate) > width && current.length > 0) {
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

/** A component object pi-tui can mount directly. */
export class MissionControl {
	readonly view: MissionView;
	onSteer?: (text: string) => void;
	onInterrupt?: () => void;

	constructor(view = new MissionView()) {
		this.view = view;
	}

	render(width: number, height = 30): string[] {
		return renderMission(this.view, width, height).map((line) => truncateToWidth(line, width, "…"));
	}

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
