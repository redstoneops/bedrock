// Slash command discovery shared by help and editor completion.

export const SLASH_COMMANDS = [
	{ name: "help", description: "Browse commands and shortcuts" },
	{ name: "goal", description: "Start a verified mission", argumentHint: "<goal>" },
	{ name: "plan", description: "Inspect the current strategy, or preview a goal", argumentHint: "[goal]" },
	{ name: "status", description: "Show the current session status" },
	{ name: "cost", description: "Show estimated spend and budget" },
	{ name: "agents", description: "Toggle the agent hub (Ctrl+K)" },
	{ name: "ledger", description: "Toggle the ledger pane (Ctrl+L)" },
	{ name: "gate", description: "Show gate check status" },
	{ name: "proof", description: "Show the latest proof path" },
	{ name: "login", description: "Sign in to a provider", argumentHint: "[provider] [oauth|api-key]" },
	{ name: "logout", description: "Remove stored credentials", argumentHint: "[provider]" },
	{ name: "providers", description: "Browse provider authentication", argumentHint: "[query]" },
	{ name: "model", description: "Browse or select a worker model", argumentHint: "[provider/model|auto]" },
	{ name: "skills", description: "Browse or install user skills", argumentHint: "[add <path>]" },
	{ name: "skill", description: "Select an installed skill for this session", argumentHint: "[name|off]" },
	{ name: "clear", description: "Clear the visible transcript" },
	{ name: "quit", description: "Leave Mission Control" },
];

export const SLASH_HELP = [
	...SLASH_COMMANDS.map(
		({ name, description, argumentHint }) => `/${name}${argumentHint ? ` ${argumentHint}` : ""} — ${description}`,
	),
	"Ctrl+P opens the command picker. Tab completes a slash command.",
	"Esc cancels a question or interrupts a run.",
	"Typing during a run steers the workers. Ctrl+C twice exits a running session.",
];
