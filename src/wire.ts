// Wiring: connects the core to Pi's extension API. Type-only Pi imports, so it runs under plain `node --test`;
// runtime values (agent dir, TUI components) are injected by extensions/compactor.ts.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig, type CompactorConfig } from "./config.ts";
import { createStore, type Store } from "./store.ts";
import { registerCycle, type Cycle } from "./cycle.ts";
import { registerCommands, type CommandCtx } from "./commands.ts";
import { createStatus, STATUS_KEY, type StatusView } from "./status.ts";
import { CHANNELS } from "./protocol.ts";

export interface WireOptions {
	agentDir: string;
	/** Where notices go without a UI (print/JSON/RPC); stdout stays free for Pi's output. */
	stderr?: (text: string) => void;
	/** Pi's `convertToLlm` and `serializeConversation` (runtime exports); without them summaries fail and Pi's default compaction runs. */
	convertToLlm?: (messages: never[]) => unknown;
	serializeConversation?: (messages: never) => string;
	/** Pi's `estimateTokens` (runtime export) for the compaction cut; defaults to chars/4. */
	estimateTokens?: (message: never) => number;
	/** Pi's `compaction.keepRecentTokens` for this session; defaults to 20000. */
	keepRecentTokens?: (ctx: never) => number;
}

export interface Settings {
	/** Config for the current cwd and model; re-read from disk so edits apply without reload. */
	current(): CompactorConfig;
	store(): Store;
	warnings(): string[];
}

type Ctx = Pick<ExtensionContext, "cwd" | "hasUI" | "ui" | "model" | "getContextUsage">;

export const modelKey = (model: { provider: string; id: string } | undefined) => (model ? `${model.provider}/${model.id}` : undefined);

export interface Compactor extends Settings {
	settings: Settings;
	cycle: Cycle;
}

export function registerCompactor(pi: ExtensionAPI, options: WireOptions): Compactor {
	const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
	let ctx: Ctx | undefined;
	let model: string | undefined;
	let lastWarnings = "";
	let warnings: string[] = [];

	const store = () => createStore({ agentDir: options.agentDir, cwd: ctx?.cwd ?? process.cwd() });
	const notify = (text: string, type: "info" | "warning" | "error" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(text, type);
		else stderr(`[compactor] ${text}\n`);
	};
	const current = () => {
		const loaded = store().load();
		const resolved = resolveConfig({ global: loaded.global, project: loaded.project, model });
		warnings = [...loaded.warnings, ...resolved.warnings];
		const key = warnings.join("\n");
		if (key !== lastWarnings) {
			lastWarnings = key;
			if (warnings.length > 0) notify(`settings adjusted:\n${warnings.join("\n")}`, "warning");
		}
		return resolved.config;
	};

	/** Cycle phase and last observed percent; the cycle reports them, the footer also reads the live usage and config. */
	let cycleView: { phase: StatusView["phase"]; percent: number | undefined } = { phase: "idle", percent: undefined };
	const status = createStatus((text) => {
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	});
	/** Recompute the always-on footer status from the cycle, Pi's usage and the effective config. */
	const refreshStatus = () => {
		if (!ctx?.hasUI) return;
		// Quiet read: warnings are notified by `current()` at the points that already do so, never by the footer.
		const loaded = store().load();
		const config = resolveConfig({ global: loaded.global, project: loaded.project, model }).config;
		const u = ctx.getContextUsage?.();
		const usage = u && u.tokens !== null && u.percent !== null ? { tokens: u.tokens, percent: u.percent, contextWindow: u.contextWindow } : undefined;
		if (usage) compactedFrom = undefined;
		status.update({ ...cycleView, enabled: config.enabled, softThreshold: config.softThreshold, usage, compactedFrom });
	};
	/** Right after a compaction Pi reports no usage; the footer says so until usage is known again. */
	let compactedFrom: number | null | undefined;
	// Registered before the cycle, so the flag is set when the cycle refreshes the footer after compacting.
	pi.events.on(CHANNELS.done, (data) => {
		const before = (data as { tokensBefore?: unknown } | undefined)?.tokensBefore;
		compactedFrom = typeof before === "number" ? before : null;
	});
	pi.on("session_compact", () => {
		if (compactedFrom === undefined) compactedFrom = null;
		refreshStatus();
	});

	pi.on("session_start", (_event, c) => {
		ctx = c;
		model = modelKey(c.model);
		current();
		refreshStatus();
	});
	pi.on("model_select", (event, c) => {
		ctx = c;
		model = modelKey(event.model);
		current();
		refreshStatus();
	});

	const settings: Settings = { current, store, warnings: () => warnings };
	const { convertToLlm, serializeConversation } = options;
	const serialize = convertToLlm && serializeConversation ? (messages: unknown[]) => serializeConversation(convertToLlm(messages as never[]) as never) : undefined;
	const cycle = registerCycle(pi, {
		config: current,
		notify,
		serialize,
		estimateTokens: options.estimateTokens as ((message: unknown) => number) | undefined,
		keepRecentTokens: options.keepRecentTokens as ((ctx: unknown) => number) | undefined,
		onChange: (phase, percent) => {
			cycleView = { phase, percent };
			refreshStatus();
		},
	});
	registerCommands(pi, {
		cycle,
		settings,
		modelKey,
		use: (c: CommandCtx) => void (ctx = c),
		changed: refreshStatus,
		say: (c, text, level = "info") => {
			if (c.hasUI) c.ui.notify(text, level);
			else stderr(`[compactor] ${text}\n`);
		},
	});
	return { ...settings, settings, cycle };
}
