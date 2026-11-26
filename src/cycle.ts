// Runs the compaction cycle on Pi's lifecycle: arms on usage, injects the preflight as a hidden message at a safe
// boundary, takes the handoff from the compaction_ready tool, compacts only when the agent is idle (ctx.compact
// aborts a running turn) and resumes the work when the cycle interrupted it.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactorConfig } from "./config.ts";
import { createController, type Boundary, type Decision, type Usage } from "./controller.ts";
import { CHANNELS, collectContributions, createCriticalSections, renderPreflight, type Contribution, type EventBus } from "./protocol.ts";

export const PREFLIGHT_TYPE = "compactor-preflight";
export const RESUME_TYPE = "compactor-resume";
export const RESUME_TEXT = "[compactor] The context was compacted. Continue the task from the handoff above; do not restart finished work.";

type Ctx = Pick<ExtensionContext, "getContextUsage" | "compact">;

export interface CycleDeps {
	config(): CompactorConfig;
	notify(text: string, type?: "info" | "warning" | "error"): void;
}

export interface CycleSnapshot {
	handoff?: string;
	contributions: Contribution[];
	reason?: "threshold" | "manual";
	why?: string;
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
			onComplete: () => {
				const state = controller.state();
				controller.compacted();
				bus.emit(CHANNELS.done, { reason: state.reason, why, handoff: state.handoff !== undefined, tokensBefore: usage?.tokens, strategy: config.strategy });
				if (resume) pi.sendMessage({ customType: RESUME_TYPE, content: RESUME_TEXT, display: false }, { triggerTurn: true, deliverAs: "followUp" });
				resume = false;
				contributions = [];
			},
			onError: (error) => {
				controller.failed(usage ?? { tokens: 0, percent: 0, contextWindow: 0 });
				resume = false;
				deps.notify(`compaction failed: ${error.message}`, "error");
			},
		});
	};

	const apply = (decision: Decision, boundary: Boundary, usage: Usage, config: CompactorConfig, ctx: Ctx) => {
		if (decision.action === "preflight") {
			if (boundary === "turn") resume = true;
			return { entries: [preflightEntry(usage, config)], continue: true };
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

	const onBoundary = (boundary: Boundary, outcome: string, ctx: Ctx, pendingTools: boolean) => {
		if (outcome !== "completed") {
			if (outcome === "aborted") controller.abort();
			return undefined;
		}
		const usage = readUsage(ctx);
		if (!usage) return undefined;
		lastUsage = usage;
		const config = deps.config();
		controller.observe(usage, config);
		const phase = controller.state().phase;
		if (phase === "compacting" && boundary === "turn" && usage.percent >= config.hardThreshold) {
			resume = true;
			compactNow(ctx);
			return undefined;
		}
		const decision = controller.atBoundary(boundary, usage, config, { criticalSections: sections.active().length, pendingTools });
		return apply(decision, boundary, usage, config, ctx);
	};

	pi.on("turn_end", (event, ctx) => onBoundary("turn", event.outcome, ctx, event.toolResults.length > 0));
	pi.on("agent_before_settle", (event, ctx) => onBoundary("settle", event.outcome, ctx, false));
	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted) {
			controller.abort();
			resume = false;
			return;
		}
		if (controller.state().phase === "compacting") compactNow(ctx);
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason !== "threshold") return undefined;
		const usage = readUsage(ctx);
		if (!usage) return undefined;
		return controller.nativeCompaction(event.reason, usage, deps.config()) === "cancel" ? { cancel: true } : undefined;
	});
	pi.on("session_compact", (event) => {
		// Pi compacted on its own (overflow, or the user ran /compact): our cycle is moot.
		if (event.reason !== "manual" || controller.state().phase !== "compacting") {
			controller.compacted();
			resume = false;
		}
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
				return;
			}
			if (decision.action === "preflight") {
				const entry = preflightEntry(usage, config);
				pi.sendMessage({ customType: entry.customType, content: entry.content, display: false, details: entry.details }, { triggerTurn: true, deliverAs: "followUp" });
			}
		},
		abort() {
			controller.abort();
			resume = false;
		},
	};
}

export type Cycle = ReturnType<typeof registerCycle>;
