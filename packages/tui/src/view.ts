// @bedrock/tui: the Mission Control view model.
//
// The view is a pure projection of the event stream. It holds no timers, no
// clients and no model state, so it can be replayed from a log and asserted in
// tests exactly as it appears on screen.

import type {
	AdvisorNote,
	BedrockEvent,
	BudgetAction,
	CheckRun,
	Id,
	LedgerSummary,
	MissionPhase,
	ProofOfWork,
	StrategyNode,
	ToolCallCard,
	WorkerStatus,
} from "@bedrock/protocol";

export interface WorkerRow {
	id: Id<"worker">;
	status: WorkerStatus;
	turns: number;
	lastAction: string;
	costUsd: number;
}

export interface ConversationLine {
	workerId?: Id<"worker">;
	kind: "text" | "tool" | "advisor" | "notice" | "verification";
	text: string;
	/** Tool card data, for tool lines. */
	card?: ToolCallCard;
	tag?: AdvisorNote["tag"];
}

export interface GateRow {
	name: string;
	status: CheckRun["status"];
	holdout: boolean;
	durationMs?: number;
}

export class MissionView {
	missionId?: Id<"mission">;
	goal = "";
	workspace = "";
	phase: MissionPhase = "bootstrap";
	costUsd = 0;
	budgetUsd?: number;
	phaseStart = Date.now();
	startedAt = Date.now();
	strategy: { rootId: Id<"strategy">; nodes: Record<string, StrategyNode> } = {
		rootId: "" as Id<"strategy">,
		nodes: {},
	};
	workers = new Map<string, WorkerRow>();
	conversation: ConversationLine[] = [];
	gate: GateRow[] = [];
	gatePassRatio = 0;
	holdoutHidden = true;
	ledger: LedgerSummary = {
		total: 0,
		byKind: {
			fact: 0,
			hypothesis: 0,
			decision: 0,
			evidence: 0,
			risk: 0,
			question: 0,
			artifact: 0,
			checkpoint: 0,
			candidate: 0,
		},
		openHypotheses: 0,
		risks: 0,
		unsupportedRatio: 0,
	};
	budgetAction?: { action: BudgetAction; reason: string };
	proof?: ProofOfWork;
	/** The line being typed by the human. */
	steering = "";
	/** Set when the human pressed Esc. */
	interrupted = false;
	/** Which extra pane is open: ledger, agents or none. */
	expanded: "none" | "ledger" | "agents" = "none";
	/** `mission` shows the strategy and gate panes; `chat` is the quick-mode transcript. */
	layout: "mission" | "chat" = "mission";
	/** A one-line status under the header, e.g. "waiting for your mission". */
	status = "";
	/** True while a mission or quick turn is running. */
	busy = false;
	/** A pending question from the agent; the next submit answers it. */
	question?: string;
	/** Recent ledger entries, newest last, for the ledger pane. */
	recentLedger: string[] = [];
	/** Rolling count of streamed deltas for the current message. */
	#streamingWorker?: Id<"worker">;

	apply(event: BedrockEvent): this {
		switch (event.type) {
			case "mission_start":
				this.busy = true;
				this.proof = undefined;
				this.missionId = event.missionId;
				this.goal = event.goal;
				this.workspace = event.workspace;
				this.startedAt = Date.now();
				break;
			case "mission_phase":
				this.phase = event.phase;
				this.phaseStart = Date.now();
				break;
			case "mission_finish":
				this.proof = event.proof;
				this.phase = "done";
				this.busy = false;
				this.status = `${event.finalState.toUpperCase()} · type a new mission, or /quit`;
				break;
			case "gate_compiled":
				this.phase = "gate";
				this.gate = (event.checkList ?? []).map((check) => ({
					name: check.name,
					status: "not_run",
					holdout: check.holdout,
				}));
				this.holdoutHidden = !(event.checkList ?? []).some((check) => check.holdout);
				break;
			case "strategy_tree":
				this.strategy = { rootId: event.tree.rootId, nodes: event.tree.nodes };
				break;
			case "strategy_node":
				this.strategy.nodes[event.node.id] = event.node;
				break;
			case "worker_spawned": {
				this.workers.set(event.workerId, {
					id: event.workerId,
					status: "starting",
					turns: 0,
					lastAction: "spawned",
					costUsd: 0,
				});
				const node = this.strategy.nodes[event.spec.strategyId];
				this.#push({
					kind: "notice",
					text: `worker ${short(event.workerId)} started: ${node?.title ?? "the mission"}${event.spec.branch ? ` (${event.spec.branch})` : ""}`,
				});
				break;
			}
			case "worker_status": {
				const worker = this.workers.get(event.workerId);
				if (worker) worker.status = event.status;
				break;
			}
			case "worker_turn": {
				const worker = this.workers.get(event.workerId);
				if (worker) worker.turns = event.turn;
				break;
			}
			case "scout_report":
				this.status = `scouted: ${
					event.report.languages
						.map((language) => language.name)
						.slice(0, 3)
						.join(", ") || "no source files"
				}${event.report.commands.test ? ` · tests: ${event.report.commands.test}` : ""}`;
				break;
			case "assistant_delta": {
				if (!event.append || this.#streamingWorker !== event.workerId) {
					this.conversation.push({ kind: "text", workerId: event.workerId, text: event.text });
					this.#streamingWorker = event.workerId;
				} else {
					const last = this.conversation.at(-1);
					if (last && last.kind === "text" && last.workerId === event.workerId) last.text += event.text;
				}
				break;
			}
			case "tool_call": {
				// A card is emitted when the call starts and again when it ends; update it in place.
				const existing = this.conversation.findLast(
					(line) => line.kind === "tool" && line.card?.toolCallId === event.card.toolCallId,
				);
				if (existing) {
					existing.card = event.card;
					existing.text = event.card.label;
				} else
					this.#push({ kind: "tool", workerId: event.card.workerId, text: event.card.label, card: event.card });
				this.#streamingWorker = undefined;
				break;
			}
			case "advisor_note":
				this.#push({ kind: "advisor", workerId: event.note.workerId, text: event.note.text, tag: event.note.tag });
				break;
			case "ledger_entry": {
				this.ledger.total += 1;
				this.ledger.byKind[event.entry.kind] += 1;
				if (event.entry.kind === "risk") this.ledger.risks += 1;
				if (event.entry.kind === "hypothesis" && event.entry.status === "open") this.ledger.openHypotheses += 1;
				const entry = event.entry as { kind: string; statement?: string; question?: string; summary?: string };
				this.recentLedger.push(`${entry.kind}: ${entry.statement ?? entry.question ?? entry.summary ?? ""}`);
				if (this.recentLedger.length > 50) this.recentLedger.shift();
				break;
			}
			case "ledger_summary":
				this.ledger = event.summary;
				break;
			case "verification":
				this.gate = [...event.result.visible, ...event.result.holdout].map((run) => ({
					name: run.name,
					status: run.status,
					holdout: event.result.holdout.includes(run),
					durationMs: run.durationMs,
				}));
				this.gatePassRatio = event.result.passRatio;
				this.holdoutHidden = event.result.holdout.length === 0;
				this.#push({
					kind: "verification",
					text: `${event.result.passed ? "PASSED" : "FAILED"} (${event.result.visible.filter((run) => run.status === "passed").length}/${event.result.visible.length} visible, ${event.result.holdout.length} holdout)`,
				});
				break;
			case "suspicion":
				this.#push({ kind: "notice", text: `integrity ${event.suspicion.severity}: ${event.suspicion.detail}` });
				break;
			case "budget_decision":
				this.budgetAction = { action: event.decision.action, reason: event.decision.reason };
				this.#push({ kind: "notice", text: `budget: ${event.decision.action} — ${event.decision.reason}` });
				break;
			case "steer":
				this.#push({ kind: "notice", text: `you: ${event.text}` });
				break;
			case "heartbeat": {
				const worker = this.workers.get(event.heartbeat.workerId);
				if (worker) {
					worker.lastAction = event.heartbeat.lastAction;
					worker.costUsd = event.heartbeat.costUsd;
				}
				break;
			}
			case "notice":
				this.#push({ kind: "notice", text: event.text });
				break;
			case "crash_recovered":
				this.#push({ kind: "notice", text: `recovered ${event.replayedEvents} events after a crash` });
				break;
			default:
				break;
		}
		return this;
	}

	#push(line: ConversationLine): void {
		this.conversation.push(line);
		if (this.conversation.length > 400) this.conversation.splice(0, this.conversation.length - 400);
	}

	/** Clears per-mission state so the same view can show the next mission. */
	reset(): void {
		this.strategy = { rootId: "" as Id<"strategy">, nodes: {} };
		this.workers.clear();
		this.gate = [];
		this.gatePassRatio = 0;
		this.holdoutHidden = true;
		this.proof = undefined;
		this.budgetAction = undefined;
		this.recentLedger = [];
		this.ledger = {
			...this.ledger,
			total: 0,
			byKind: {
				fact: 0,
				hypothesis: 0,
				decision: 0,
				evidence: 0,
				risk: 0,
				question: 0,
				artifact: 0,
				checkpoint: 0,
				candidate: 0,
			},
			openHypotheses: 0,
			risks: 0,
			unsupportedRatio: 0,
		};
		this.phase = "bootstrap";
		this.costUsd = 0;
	}

	/** Adds a local line (slash command output, prompts) to the transcript. */
	note(text: string, kind: ConversationLine["kind"] = "notice"): void {
		this.#push({ kind, text });
	}

	/** Sends a steering message. Returns the text, or undefined when empty. */
	submitSteering(): string | undefined {
		const text = this.steering.trim();
		this.steering = "";
		return text.length > 0 ? text : undefined;
	}

	/** Handles one key or printable chunk from the input line. */
	handleInput(data: string): "submit" | "interrupt" | "toggle-ledger" | "toggle-agents" | "none" {
		if (data === "\r" || data === "\n") return "submit";
		if (data === "\u001b") return "interrupt";
		if (data === "\u000b") return "toggle-agents";
		if (data === "\u000c") return "toggle-ledger";
		if (data === "\u007f" || data === "\b") {
			this.steering = this.steering.slice(0, -1);
			return "none";
		}
		// Ignore escape sequences (arrow keys, mouse) rather than inserting them.
		if (data.startsWith("\u001b")) return "none";
		const printable = data.replace(/[\u0000-\u001f]/g, "");
		this.steering += printable;
		return "none";
	}

	/** Total wall clock since the mission started, for the header. */
	elapsedMs(now = Date.now()): number {
		return Math.max(0, now - this.startedAt);
	}
}

function short(id: string): string {
	const underscore = id.indexOf("_");
	return underscore < 0 ? id : `${id.slice(0, underscore)}_${id.slice(underscore + 1, underscore + 7)}`;
}
