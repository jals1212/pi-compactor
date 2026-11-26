// `/compactor` command: status, now, off/on, plan, pin/unpin, settings (TUI editor in settings-ui.ts).
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CompactorConfig } from "./config.ts";
import { manualPins, PIN_TYPE, type Cycle } from "./cycle.ts";
import { CHANNELS } from "./protocol.ts";
import { runSettingsEditor } from "./settings-ui.ts";
import type { Settings } from "./wire.ts";

export type CommandCtx = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui" | "model" | "getContextUsage" | "compact" | "isIdle" | "sessionManager">;
export type Level = "info" | "warning" | "error";

export interface CommandDeps {
	cycle: Cycle;
	settings: Settings;
	modelKey(model: { provider: string; id: string } | undefined): string | undefined;
	/** Show text to the user: the UI when there is one, stderr otherwise. */
	say(ctx: CommandCtx, text: string, level?: Level): void;
	/** Make `ctx` the context settings notices go to. */
	use(ctx: CommandCtx): void;
}

const SUBCOMMANDS: { name: string; usage: string; description: string }[] = [
	{ name: "status", usage: "/compactor status", description: "phase, usage, thresholds, last compaction, warnings (default)" },
	{ name: "now", usage: "/compactor now", description: "compact now (preflight handoff first when enabled)" },
	{ name: "off", usage: "/compactor off", description: "turn automatic compaction off (project file)" },
	{ name: "on", usage: "/compactor on", description: "turn automatic compaction on (project file)" },
	{ name: "plan", usage: "/compactor plan", description: "describe what the next compaction would do" },
	{ name: "pin", usage: "/compactor pin [text]", description: "pin text so it survives every compaction; no text lists the pins" },
	{ name: "unpin", usage: "/compactor unpin <n>", description: "remove a pin (pins are cleared by a new session)" },
	{ name: "settings", usage: "/compactor settings", description: "edit every setting in the TUI (global, project or model scope)" },
];

const USAGE = `Usage:\n${SUBCOMMANDS.map((s) => `  ${s.usage} - ${s.description}`).join("\n")}`;

export const COMMAND_DESCRIPTION = `Context compaction: ${SUBCOMMANDS.map((s) => s.name).join(", ")}`;

interface DonePayload {
	reason?: string;
	why?: string;
	handoff?: boolean;
	tokensBefore?: number;
	strategy?: string;
	compactor?: { strategy?: string; fallback?: string; handoff?: boolean; pins?: number; tokensBefore?: number };
}

const STRATEGY_TEXT: Record<CompactorConfig["strategy"], string> = {
	summary: "Pi-style summary plus pins",
	hybrid: "handoff + summary + trimmed recent context",
	"handoff-only": "keeps only the handoff, hook contributions and pins; falls back to hybrid without a valid handoff",
};

const SAFE_POINT_TEXT: Record<CompactorConfig["safePoint"], string> = {
	settle: "waits until the agent is idle",
	turn: "waits for a turn end with no pending tool work",
	any: "any turn end",
};

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function describeLast(done: DonePayload | undefined): string {
	if (!done) return "last compaction: none yet";
	const c = done.compactor ?? {};
	const tokens = c.tokensBefore ?? done.tokensBefore;
	const parts = [
		`${done.reason ?? "unknown"}${done.why ? ` (${done.why})` : ""}`,
		`strategy ${c.strategy ?? done.strategy ?? "unknown"}`,
		`fallback: ${c.fallback ?? "none"}`,
		...(typeof tokens === "number" && tokens > 0 ? [`${Math.round(tokens)} tokens before`] : []),
		...(typeof c.pins === "number" ? [count(c.pins, "pin")] : []),
		`handoff ${(c.handoff ?? done.handoff) ? "yes" : "no"}`,
	];
	return `last compaction: ${parts.join(" · ")}`;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps) {
	const { cycle, settings } = deps;
	let lastDone: DonePayload | undefined;
	pi.events.on(CHANNELS.done, (data) => {
		if (typeof data === "object" && data !== null) lastDone = data as DonePayload;
	});

	const status = (ctx: CommandCtx) => {
		const config = settings.current();
		const state = cycle.state();
		const usage = ctx.getContextUsage();
		const sections = cycle.sections.active();
		const lines = [
			`phase: ${state.phase}${state.reason ? ` (${state.reason})` : ""}`,
			usage && usage.tokens !== null && usage.percent !== null
				? `usage: ${Math.round(usage.percent)}% (${Math.round(usage.tokens)} of ${usage.contextWindow} tokens)`
				: "usage: unknown",
			`thresholds: soft ${config.softThreshold}% · hard ${config.hardThreshold}% · defer up to ${config.maxDeferTokens} tokens`,
			`strategy: ${config.strategy}`,
			`safe point: ${config.safePoint}`,
			`automatic compaction: ${config.enabled ? "on" : "off"}`,
			`critical sections: ${sections.length === 0 ? "none" : sections.map((s) => (s.reason ? `${s.source} (${s.reason})` : s.source)).join(", ")}`,
			describeLast(lastDone),
		];
		const warnings = settings.warnings();
		if (warnings.length > 0) lines.push(`settings warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}`);
		deps.say(ctx, lines.join("\n"));
	};

	const now = (ctx: CommandCtx) => {
		if (cycle.state().phase === "preflight" || cycle.state().phase === "compacting") {
			deps.say(ctx, `a compaction is already running (${cycle.state().phase})`, "warning");
			return;
		}
		cycle.request(ctx);
		const phase = cycle.state().phase;
		deps.say(ctx, phase === "preflight" ? "preflight started: the agent hands off its state, then the context is compacted" : "compacting");
	};

	const setEnabled = (ctx: CommandCtx, enabled: boolean) => {
		const store = settings.store();
		const result = store.update("project", "enabled", enabled);
		if (!result.ok) return deps.say(ctx, result.error, "error");
		settings.current();
		deps.say(ctx, `automatic compaction ${enabled ? "on" : "off"} (project: ${store.paths.project})`);
	};

	const plan = (ctx: CommandCtx) => {
		const c = settings.current();
		const sections = cycle.sections.active().length;
		const lines = [
			c.enabled ? "next automatic compaction:" : "automatic compaction is off; only /compactor now compacts. A compaction would:",
			`- starts when the context reaches ${c.softThreshold}%; forced at ${c.hardThreshold}% or after ${c.maxDeferTokens} tokens of growth`,
			`- safe point: ${c.safePoint} (${SAFE_POINT_TEXT[c.safePoint]})${sections > 0 ? `; ${count(sections, "critical section")} active` : ""}`,
			c.preflight.enabled
				? `- preflight: on (up to ${count(c.preflight.maxTurns, "turn")}, ${c.preflight.budgetTokens} tokens; ${c.preflight.template === null ? "built-in" : "custom"} template)`
				: "- preflight: off (compacts without asking for a handoff)",
			`- strategy: ${c.strategy} (${STRATEGY_TEXT[c.strategy]})`,
			c.pruning.enabled
				? `- pruning: on (tool results over ${c.pruning.minToolResultTokens} tokens, keeping the last ${count(c.pruning.keepRecentTurns, "turn")})`
				: "- pruning: off",
			`- summary model: ${c.summaryModel ?? "session model"}`,
			`- pins: ${[c.pins.originalRequest ? "original request" : undefined, c.pins.userCorrections ? "user corrections" : undefined, "manual pins"].filter(Boolean).join(", ")} (up to ${c.pins.maxTokens} tokens)`,
		];
		deps.say(ctx, lines.join("\n"));
	};

	const pin = (ctx: CommandCtx, text: string) => {
		if (text === "") {
			const pins = manualPins(ctx.sessionManager.getBranch());
			deps.say(ctx, pins.length === 0 ? "No pins. Add one with /compactor pin <text>." : `Pins:\n${pins.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
			return;
		}
		pi.appendEntry(PIN_TYPE, { text });
		deps.say(ctx, `Pinned: ${text}`);
	};

	const run = async (args: string, ctx: CommandCtx) => {
		deps.use(ctx);
		const match = /^(\S*)\s*([\s\S]*)$/.exec(args.trim());
		const word = match?.[1] || "status";
		const rest = match?.[2]?.trim() ?? "";
		const noArgs = (fn: () => void | Promise<void>) => {
			if (rest !== "") return deps.say(ctx, `/compactor ${word} takes no arguments.\n${USAGE}`, "error");
			return fn();
		};
		switch (word) {
			case "status":
				return noArgs(() => status(ctx));
			case "now":
				return noArgs(() => now(ctx));
			case "off":
				return noArgs(() => setEnabled(ctx, false));
			case "on":
				return noArgs(() => setEnabled(ctx, true));
			case "plan":
				return noArgs(() => plan(ctx));
			case "pin":
				return pin(ctx, rest);
			case "unpin":
				return deps.say(ctx, "Pi has no API to remove session entries, so pins cannot be removed: they are cleared by starting a new session.", "warning");
			case "settings":
				if (!ctx.hasUI) return deps.say(ctx, "/compactor settings needs the interactive TUI; run it in an interactive Pi session.", "warning");
				return runSettingsEditor(ctx, { store: settings.store, current: settings.current, model: deps.modelKey(ctx.model), say: (t, l) => deps.say(ctx, t, l) });
			default:
				return deps.say(ctx, `Unknown subcommand "${word}".\n${USAGE}`, "error");
		}
	};

	pi.registerCommand("compactor", {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return null;
			return SUBCOMMANDS.filter((s) => s.name.startsWith(prefix)).map((s) => ({ value: s.name, label: s.name, description: s.description }));
		},
		handler: (args, ctx) => run(args, ctx),
	});
}
