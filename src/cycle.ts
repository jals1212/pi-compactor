// Runs the compaction cycle on Pi's lifecycle: arms on usage, injects the preflight as a hidden message at a safe
// boundary, takes the handoff from the compaction_ready tool, then compacts by one of two routes chosen from `ctx.mode`:
// - `tui`/`rpc` (the runtime outlives the prompt): Pi's own compaction (`ctx.compact`) at `agent_settled`, or at a turn
//   end with a resume; Pi then fires `session_before_compact`/`session_compact`, which other extensions listen to.
// - `print`/`json`/unknown (the runtime is disposed when the prompt resolves, aborting a fire-and-forget compaction):
//   the compaction is written as a boundary draft (plus a hidden resume message and `continue` when work was
//   interrupted); Pi awaits boundary handlers inside the running prompt.
import type { BoundaryResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactorConfig } from "./config.ts";
import { planPruning } from "./pruning.ts";
import { createController, type Boundary, type Decision, type Phase, type Usage } from "./controller.ts";
import { buildCompaction, type CompactorDetails, type Preparation } from "./strategy.ts";
import { KEEP_RECENT_TOKENS, prepareFromProjection } from "./prepare.ts";
import { createSummarizer } from "./summarize.ts";
import { CHANNELS, collectContributions, createCriticalSections, renderPreflight, type Contribution, type EventBus } from "./protocol.ts";

export const PREFLIGHT_TYPE = "compactor-preflight";
export const RESUME_TYPE = "compactor-resume";
/** Session custom entry `{ customType: PIN_TYPE, data: { text } }` pins text so it survives every compaction. */
export const PIN_TYPE = "compactor-pin";
export const RESUME_TEXT = "[compactor] The context was compacted. Continue the task from the handoff above; do not restart finished work.";

type Ctx = Pick<ExtensionContext, "getContextUsage" | "compact"> & Partial<Pick<ExtensionContext, "signal" | "sessionManager" | "mode">>;

/** Modes whose runtime stays alive after the prompt, so Pi's fire-and-forget compaction completes. */
const usesPiCompaction = (ctx: Ctx) => ctx.mode === "tui" || ctx.mode === "rpc";

export interface CycleDeps {
	config(): CompactorConfig;
	notify(text: string, type?: "info" | "warning" | "error"): void;
	/** Messages to readable text (Pi's `serializeConversation(convertToLlm(messages))`); injected as a runtime value. */
	serialize?(messages: unknown[]): string;
	/** Pi's `estimateTokens` (runtime value); defaults to chars/4. */
	estimateTokens?(message: unknown): number;
	/** Pi's `compaction.keepRecentTokens` for the session; defaults to Pi's 20000. */
	keepRecentTokens?(ctx: unknown): number;
	/** Called after the cycle may have changed phase (boundaries, compaction done or failed, requests, aborts). */
	onChange?(phase: Phase, percent: number | undefined): void;
}

export interface CycleSnapshot {
	handoff?: string;
	contributions: Contribution[];
	reason?: "threshold" | "manual";
	why?: string;
}

/** Text of the manual pins in the session's custom entries, oldest first. */
export function manualPins(branchEntries: unknown[]): string[] {
	const out: string[] = [];
	for (const e of branchEntries as { type?: string; customType?: string; data?: { text?: unknown } }[]) {
		if (e?.type !== "custom" || e.customType !== PIN_TYPE) continue;
		const text = e.data?.text;
		if (typeof text === "string" && text.trim()) out.push(text.trim());
	}
	return out;
}

const readUsage = (ctx: Ctx): Usage | undefined => {
	const u = ctx.getContextUsage();
	if (!u || u.tokens === null || u.percent === null) return undefined;
	return { tokens: u.tokens, percent: u.percent, contextWindow: u.contextWindow };
};

export function registerCycle(pi: ExtensionAPI, deps: CycleDeps) {
	const bus = pi.events as unknown as EventBus;
	const controller = createController();
	const sections = createCriticalSections(bus);
	/** The cycle interrupted work in progress, so the agent is nudged to continue after compaction. */
	let resume = false;
	let contributions: Contribution[] = [];
	let why: string | undefined;
	let lastUsage: Usage | undefined;
	const changed = () => deps.onChange?.(controller.state().phase, lastUsage?.percent);

	const preflightEntry = (usage: Usage, config: CompactorConfig) => {
		const collected = collectContributions(bus, { reason: controller.state().reason ?? "threshold", strategy: config.strategy });
		contributions = collected.contributions;
		for (const w of collected.warnings) deps.notify(w, "warning");
		return {
			type: "custom_message" as const,
			customType: PREFLIGHT_TYPE,
			content: renderPreflight({ template: config.preflight.template, strategy: config.strategy, reason: controller.state().reason ?? "threshold", percent: usage.percent, steps: contributions }),
			display: false,
			details: { percent: usage.percent, tokens: usage.tokens },
		};
	};

	const compactNow = (ctx: Ctx) => {
		const usage = lastUsage;
		const config = deps.config();
		ctx.compact({
			customInstructions: controller.state().handoff,
			onComplete: (result) => {
				const state = controller.state();
				controller.compacted();
				const compactor = (result as { details?: { compactor?: unknown } } | undefined)?.details?.compactor;
				bus.emit(CHANNELS.done, { reason: state.reason, why, handoff: state.handoff !== undefined, tokensBefore: usage?.tokens, strategy: config.strategy, compactor });
				if (resume) pi.sendMessage({ customType: RESUME_TYPE, content: RESUME_TEXT, display: false }, { triggerTurn: true, deliverAs: "followUp" });
				resume = false;
				contributions = [];
				why = undefined;
				changed();
			},
			onError: (error) => {
				controller.failed(usage ?? { tokens: 0, percent: 0, contextWindow: 0 });
				resume = false;
				why = undefined;
				deps.notify(`compaction failed: ${error.message}`, "error");
				changed();
			},
		});
	};

	const fail = (message: string) => {
		controller.failed(lastUsage ?? { tokens: 0, percent: 0, contextWindow: 0 });
		resume = false;
		why = undefined;
		deps.notify(`compaction failed: ${message}`, "error");
	};

	/** The compaction as boundary drafts: after `entries`, the compaction, then (when work was interrupted) a hidden resume message. */
	const compactAtBoundary = async (boundary: Boundary, ctx: Ctx, entries: readonly unknown[], context: unknown) => {
		const config = deps.config();
		const state = controller.state();
		const projected = (context as { contextEntries?: unknown } | undefined)?.contextEntries;
		let keep = KEEP_RECENT_TOKENS;
		try {
			keep = deps.keepRecentTokens?.(ctx) ?? KEEP_RECENT_TOKENS;
		} catch {}
		const preparation = Array.isArray(projected) ? prepareFromProjection(projected as never, keep, deps.estimateTokens) : undefined;
		if (!preparation) {
			fail("Nothing to compact (session too small)");
			return undefined;
		}
		const signal = ctx.signal ?? new AbortController().signal;
		const branch = (ctx.sessionManager as { getBranch?(): unknown[] } | undefined)?.getBranch?.() ?? (projected as { sourceEntry: unknown }[]).map((e) => e.sourceEntry);
		try {
			const built = await buildCompaction({
				strategy: config.strategy,
				preparation,
				branchEntries: branch,
				handoff: state.handoff,
				contributions,
				pins: config.pins,
				manualPins: manualPins(branch),
				summarize: summarizer(ctx, config, signal),
			});
			if (signal.aborted) {
				controller.cancel();
				resume = false;
				return undefined;
			}
			// Pi's own measure (getContextUsage uses the estimator Pi stores in the entry); ours only when Pi has none.
			const tokensBefore = readUsage(ctx)?.tokens ?? preparation.tokensBefore;
			const compactor: CompactorDetails & { reason: string; tokensBefore: number; why?: string } = {
				...built.compaction.details.compactor,
				reason: state.reason ?? "threshold",
				tokensBefore,
			};
			if (why !== undefined) compactor.why = why;
			const draft: Record<string, unknown> = { type: "compaction", summary: built.compaction.summary, firstKeptEntryId: built.compaction.firstKeptEntryId, details: { compactor } };
			if (built.compaction.usage !== undefined) draft.usage = built.compaction.usage;
			const out: unknown[] = [...entries, draft];
			// At a turn end the agent is mid-task; at settle only when the cycle interrupted it (preflight at a turn end).
			const resumes = boundary === "turn" || resume;
			if (resumes) out.push({ type: "custom_message", customType: RESUME_TYPE, content: RESUME_TEXT, display: false });
			controller.compacted();
			bus.emit(CHANNELS.done, { reason: state.reason, why, handoff: state.handoff !== undefined, tokensBefore, strategy: config.strategy, compactor });
			resume = false;
			contributions = [];
			why = undefined;
			return resumes ? { entries: out, continue: true } : { entries: out };
		} catch (error) {
			if (signal.aborted) {
				controller.cancel();
				resume = false;
				return undefined;
			}
			fail(error instanceof Error ? error.message : String(error));
			return undefined;
		}
	};

	/** Marks a boundary where the cycle compacts (handled asynchronously by `onBoundary`); `edits` are the pruning edits. */
	const COMPACT = Symbol("compact");
	type Compact = { [COMPACT]: true; edits: readonly unknown[] };
	const compact = (edits: readonly unknown[] = []): Compact => ({ [COMPACT]: true, edits });
	const isCompact = (r: unknown): r is Compact => typeof r === "object" && r !== null && COMPACT in r;

	const apply = (decision: Decision, boundary: Boundary, usage: Usage, config: CompactorConfig, entries: readonly unknown[]) => {
		if (decision.action === "preflight") {
			if (boundary === "turn") resume = true;
			// Pi replaces event.entries with the returned list, so the drafts already there must be carried over.
			return { entries: [...entries, preflightEntry(usage, config)], continue: true };
		}
		if (decision.action === "compact") {
			why = decision.why;
			return compact();
		}
		return undefined;
	};

	/** Prune old large tool outputs once usage crosses the soft threshold; returns the edits and the usage they leave. */
	const prune = (usage: Usage, config: CompactorConfig, context: unknown) => {
		const contextEntries = (context as { contextEntries?: unknown } | undefined)?.contextEntries;
		if (!config.pruning.enabled || !Array.isArray(contextEntries) || usage.percent < config.softThreshold) return { edits: [], usage };
		const target = usage.tokens - ((config.softThreshold - 5) / 100) * usage.contextWindow;
		const plan = planPruning(contextEntries as never, config.pruning, { targetTokens: Math.max(1, target) });
		if (plan.edits.length === 0) return { edits: [], usage };
		const tokens = Math.max(0, usage.tokens - plan.savedTokens);
		return { edits: plan.edits, usage: { ...usage, tokens, percent: (tokens / usage.contextWindow) * 100 } };
	};

	const onBoundary = async (boundary: Boundary, outcome: string, ctx: Ctx, pendingTools: boolean, entries: readonly unknown[] = [], context?: unknown) => {
		try {
			const result = handleBoundary(boundary, outcome, ctx, pendingTools, entries, context);
			if (!isCompact(result)) return result;
			if (!usesPiCompaction(ctx)) return await compactAtBoundary(boundary, ctx, entries, context);
			// Pi's route: at settle `agent_settled` compacts once idle; at a turn end compacting aborts the turn, so resume after.
			if (boundary === "turn") {
				resume = true;
				compactNow(ctx);
			}
			return result.edits.length > 0 ? { entries: [...entries, ...result.edits] } : undefined;
		} finally {
			changed();
		}
	};

	const handleBoundary = (boundary: Boundary, outcome: string, ctx: Ctx, pendingTools: boolean, entries: readonly unknown[], context: unknown) => {
		if (outcome !== "completed") {
			if (outcome === "aborted") controller.abort();
			return undefined;
		}
		const phaseBefore = controller.state().phase;
		// The handoff is in: the run is settling, so compact now (the agent was told to stop after compaction_ready).
		if (phaseBefore === "compacting" && boundary === "settle") {
			why ??= "handoff ready";
			return compact();
		}
		const measured = readUsage(ctx);
		if (!measured) return undefined;
		const config = deps.config();
		const pruned = phaseBefore === "idle" || phaseBefore === "pending" ? prune(measured, config, context) : { edits: [], usage: measured };
		const usage = pruned.usage;
		lastUsage = usage;
		controller.observe(usage, config);
		const result = decide(boundary, usage, config, pendingTools, [...entries, ...pruned.edits]);
		if (isCompact(result)) return compact(pruned.edits);
		if (result) return result;
		return pruned.edits.length > 0 ? { entries: [...entries, ...pruned.edits] } : undefined;
	};

	const decide = (boundary: Boundary, usage: Usage, config: CompactorConfig, pendingTools: boolean, entries: readonly unknown[]) => {
		const phase = controller.state().phase;
		if (phase === "compacting" && boundary === "turn" && usage.percent >= config.hardThreshold) {
			why ??= "hard limit while compacting";
			return compact();
		}
		const decision = controller.atBoundary(boundary, usage, config, { criticalSections: sections.active().length, pendingTools });
		return apply(decision, boundary, usage, config, entries);
	};

	const summarizer = (ctx: Ctx, config: CompactorConfig, signal: AbortSignal) =>
		createSummarizer({
			ctx: ctx as never,
			summaryModel: config.summaryModel,
			signal,
			serialize:
				deps.serialize ??
				(() => {
					throw new Error("conversation serializer not available");
				}),
			warn: (text) => deps.notify(text, "warning"),
		});

	// Drafts are built as plain objects; Pi validates them when the boundary preview is rebuilt. Pi awaits the handlers.
	pi.on("turn_end", (event, ctx) => onBoundary("turn", event.outcome, ctx, event.toolResults.length > 0, event.entries, event.context) as Promise<BoundaryResult | undefined>);
	pi.on("agent_before_settle", (event, ctx) => onBoundary("settle", event.outcome, ctx, false, event.entries, event.context) as Promise<BoundaryResult | undefined>);
	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted) {
			controller.abort();
			resume = false;
		} else if (controller.state().phase === "compacting") {
			// Still compacting once idle: Pi's own compaction (the Pi route's settle, or `/compactor now` during a run).
			// A boundary compaction already left the phase, so this never compacts twice.
			why ??= "handoff ready";
			compactNow(ctx);
		}
		changed();
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const config = deps.config();
		if (event.reason === "threshold") {
			const usage = readUsage(ctx);
			if (usage && controller.nativeCompaction(event.reason, usage, config) === "cancel") return { cancel: true };
		}
		if (!config.enabled) return undefined;
		const state = controller.state();
		// Only the compaction this cycle asked for (ctx.compact reports "manual") may use the cycle's handoff.
		const ours = event.reason === "manual" && state.phase === "compacting";
		try {
			const summarize = summarizer(ctx, config, event.signal);
			const built = await buildCompaction({
				strategy: config.strategy,
				preparation: event.preparation as unknown as Preparation,
				branchEntries: event.branchEntries,
				handoff: ours ? state.handoff : undefined,
				contributions: ours ? contributions : [],
				pins: config.pins,
				manualPins: manualPins(event.branchEntries),
				summarize,
			});
			const compactor: CompactorDetails & { reason: string; tokensBefore: number; why?: string } = {
				...built.compaction.details.compactor,
				reason: ours ? (state.reason ?? event.reason) : event.reason,
				tokensBefore: event.preparation.tokensBefore,
			};
			if (ours && why !== undefined) compactor.why = why;
			// firstKeptEntryId is typed string; null (retain-none) is honored by Pi's hook path (prototype/retain-none.test.ts).
			return { compaction: { ...built.compaction, details: { compactor } } as never };
		} catch (error) {
			if (!event.signal.aborted) deps.notify(`compaction failed, using Pi's default: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return undefined;
		}
	});
	pi.on("session_compact", (event) => {
		// Pi compacted on its own (overflow, or the user ran /compact): our cycle is moot.
		if (event.reason !== "manual" || controller.state().phase !== "compacting") {
			controller.compacted();
			resume = false;
		}
		changed();
	});

	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
	pi.registerTool({
		name: "compaction_ready",
		label: "Compaction ready",
		description:
			"Call once when the compactor asks for a handoff before compacting the context. Pass the handoff: goal, done, in progress, next steps, key decisions and constraints, files involved. Then stop and wait.",
		parameters: {
			type: "object",
			properties: { handoff: { type: "string", description: "State to keep across compaction" } },
			required: ["handoff"],
			additionalProperties: false,
		} as never,
		async execute(_id: string, params: { handoff?: unknown }) {
			const handoff = typeof params.handoff === "string" ? params.handoff.trim() : "";
			if (controller.state().phase !== "preflight") return text("No compaction is pending; nothing to do.");
			if (!handoff) return text("The handoff must not be empty. Call compaction_ready again with your state.");
			controller.ready(handoff);
			changed();
			return text("Handoff saved. Stop now: the context is compacted as soon as you finish this turn.");
		},
	} as never);
	pi.registerTool({
		name: "compaction_defer",
		label: "Compaction defer",
		description:
			"Mark a critical section that automatic context compaction must not interrupt (active: true), and end it (active: false). Compaction still runs if the context is about to overflow.",
		parameters: {
			type: "object",
			properties: { active: { type: "boolean" }, reason: { type: "string" } },
			required: ["active"],
			additionalProperties: false,
		} as never,
		async execute(_id: string, params: { active?: unknown; reason?: unknown }) {
			const active = params.active === true;
			sections.set("agent", active, typeof params.reason === "string" ? params.reason : undefined);
			return text(active ? "Critical section started; compaction waits until you end it." : "Critical section ended.");
		},
	} as never);

	return {
		state: () => controller.state(),
		snapshot: (): CycleSnapshot => ({ handoff: controller.state().handoff, contributions, reason: controller.state().reason, why }),
		sections,
		/** `/compactor now`. */
		request(ctx: Ctx & { isIdle(): boolean }) {
			const usage = readUsage(ctx) ?? { tokens: 0, percent: 0, contextWindow: 0 };
			lastUsage = usage;
			const config = deps.config();
			const decision = controller.request(usage, config);
			if (decision.action === "compact") {
				why = decision.why;
				if (ctx.isIdle()) compactNow(ctx);
			} else if (decision.action === "preflight") {
				const entry = preflightEntry(usage, config);
				pi.sendMessage({ customType: entry.customType, content: entry.content, display: false, details: entry.details }, { triggerTurn: true, deliverAs: "followUp" });
			}
			changed();
		},
		abort() {
			controller.abort();
			resume = false;
			changed();
		},
	};
}

export type Cycle = ReturnType<typeof registerCycle>;
