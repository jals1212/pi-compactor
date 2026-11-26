// Runs the compaction cycle on Pi's lifecycle: arms on usage, injects the preflight as a hidden message at a safe
// boundary, takes the handoff from the compaction_ready tool, compacts only when the agent is idle (ctx.compact
// aborts a running turn) and resumes the work when the cycle interrupted it.
import type { BoundaryResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactorConfig } from "./config.ts";
import { planPruning } from "./pruning.ts";
import { createController, type Boundary, type Decision, type Phase, type Usage } from "./controller.ts";
import { buildCompaction, type CompactorDetails, type Preparation } from "./strategy.ts";
import { createSummarizer } from "./summarize.ts";
import { CHANNELS, collectContributions, createCriticalSections, renderPreflight, type Contribution, type EventBus } from "./protocol.ts";

export const PREFLIGHT_TYPE = "compactor-preflight";
export const RESUME_TYPE = "compactor-resume";
/** Session custom entry `{ customType: PIN_TYPE, data: { text } }` pins text so it survives every compaction. */
export const PIN_TYPE = "compactor-pin";
export const RESUME_TEXT = "[compactor] The context was compacted. Continue the task from the handoff above; do not restart finished work.";

type Ctx = Pick<ExtensionContext, "getContextUsage" | "compact">;

export interface CycleDeps {
	config(): CompactorConfig;
	notify(text: string, type?: "info" | "warning" | "error"): void;
	/** Messages to readable text (Pi's `serializeConversation(convertToLlm(messages))`); injected as a runtime value. */
	serialize?(messages: unknown[]): string;
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

	const apply = (decision: Decision, boundary: Boundary, usage: Usage, config: CompactorConfig, ctx: Ctx, entries: readonly unknown[]) => {
		if (decision.action === "preflight") {
			if (boundary === "turn") resume = true;
			// Pi replaces event.entries with the returned list, so the drafts already there must be carried over.
			return { entries: [...entries, preflightEntry(usage, config)], continue: true };
		}
		if (decision.action === "compact") {
			why = decision.why;
			// At a turn end the agent is still running: compacting aborts it, so resume afterwards. At settle, wait for idle.
			if (boundary === "turn") {
				resume = true;
				compactNow(ctx);
			}
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

	const onBoundary = (...args: Parameters<typeof handleBoundary>) => {
		try {
			return handleBoundary(...args);
		} finally {
			changed();
		}
	};

	const handleBoundary = (boundary: Boundary, outcome: string, ctx: Ctx, pendingTools: boolean, entries: readonly unknown[] = [], context?: unknown) => {
		if (outcome !== "completed") {
			if (outcome === "aborted") controller.abort();
			return undefined;
		}
		const measured = readUsage(ctx);
		if (!measured) return undefined;
		const config = deps.config();
		const phaseBefore = controller.state().phase;
		const pruned = phaseBefore === "idle" || phaseBefore === "pending" ? prune(measured, config, context) : { edits: [], usage: measured };
		const usage = pruned.usage;
		lastUsage = usage;
		controller.observe(usage, config);
		const result = decide(boundary, usage, config, ctx, pendingTools, [...entries, ...pruned.edits]);
		if (result) return result;
		return pruned.edits.length > 0 ? { entries: [...entries, ...pruned.edits] } : undefined;
	};

	const decide = (boundary: Boundary, usage: Usage, config: CompactorConfig, ctx: Ctx, pendingTools: boolean, entries: readonly unknown[]) => {
		const phase = controller.state().phase;
		if (phase === "compacting" && boundary === "turn" && usage.percent >= config.hardThreshold) {
			resume = true;
			compactNow(ctx);
			return undefined;
		}
		const decision = controller.atBoundary(boundary, usage, config, { criticalSections: sections.active().length, pendingTools });
		return apply(decision, boundary, usage, config, ctx, entries);
	};

	// Drafts are built as plain objects; Pi validates them when the boundary preview is rebuilt.
	pi.on("turn_end", (event, ctx) => onBoundary("turn", event.outcome, ctx, event.toolResults.length > 0, event.entries, event.context) as BoundaryResult | undefined);
	pi.on("agent_before_settle", (event, ctx) => onBoundary("settle", event.outcome, ctx, false, event.entries, event.context) as BoundaryResult | undefined);
	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted) {
			controller.abort();
			resume = false;
		} else if (controller.state().phase === "compacting") {
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
			const summarize = createSummarizer({
				ctx,
				summaryModel: config.summaryModel,
				signal: event.signal,
				serialize:
					deps.serialize ??
					(() => {
						throw new Error("conversation serializer not available");
					}),
				warn: (text) => deps.notify(text, "warning"),
			});
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
