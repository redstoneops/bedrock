// @bedrock/protocol: the shared contract between every Bedrock package.
//
// Nothing here has runtime dependencies beyond the Node standard library.
// Packages import types from here so the mission loop, gate compiler,
// verifier, TUI, daemon and lab agree on one vocabulary.

export * from "./events.ts";
export * from "./gate.ts";
export * from "./ids.ts";
export * from "./interfaces.ts";
export * from "./ledger.ts";
export * from "./mission.ts";
export * from "./permissions.ts";
export * from "./roles.ts";

/** A one-line human summary of a ledger entry, used by TUI strips and prompt assembly. */
export function summarizeEntry(entry: {
	kind: string;
	id: string;
	statement?: string;
	question?: string;
	summary?: string;
	label?: string;
}): string {
	const text = entry.statement ?? entry.question ?? entry.summary ?? entry.label ?? "";
	const short = text.length > 120 ? `${text.slice(0, 117)}...` : text;
	return `${entry.kind} ${entry.id}: ${short}`;
}
