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
	/** Rolling count of streamed deltas for the current message. */
	#streamingWorker?: Id<"worker">;

	apply(event: BedrockEvent): this {
		switch (event.type) {
			case "mission_start":
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
				break;
			case "gate_compiled":
				this.phase = "gate";
				break;
			case "strategy_tree":
				this.strategy = { rootId: event.tree.rootId, nodes: event.tree.nodes };
				break;
			case "strategy_node":
				this.strategy.nodes[event.node.id] = event.node;
				break;
			case "worker_spawned":
				this.workers.set(event.workerId, {
					id: event.workerId,
					status: "starting",
					turns: 0,
					lastAction: "spawned",
					costUsd: 0,
				});
				this.#push({
					kind: "notice",
					text: `worker ${short(event.workerId)} started on ${event.spec.strategyId ? short(event.spec.strategyId) : "the mission"}`,
				});
				break;
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
			case "tool_call":
				this.#push({ kind: "tool", workerId: event.card.workerId, text: event.card.label, card: event.card });
				break;
			case "advisor_note":
				this.#push({ kind: "advisor", workerId: event.note.workerId, text: event.note.text, tag: event.note.tag });
				break;
			case "ledger_entry":
				this.ledger.total += 1;
				this.ledger.byKind[event.entry.kind] += 1;
				break;
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
