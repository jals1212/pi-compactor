// Compaction cycle state machine, pure: idle -> pending (soft threshold crossed, waiting for a safe point)
// -> preflight (agent hands off, bounded by turns and tokens) -> compacting -> idle. A failed compaction cools down
// until the context grows by `maxDeferTokens`, so a failing compaction never loops.
import type { CompactorConfig } from "./config.ts";

export type Phase = "idle" | "pending" | "preflight" | "compacting" | "cooldown";
export type Boundary = "turn" | "settle";

export interface Usage {
	percent: number;
	tokens: number;
	contextWindow: number;
}

export interface CycleState {
	phase: Phase;
	reason?: "threshold" | "manual";
	/** Tokens when the cycle armed, preflight started, or the last compaction failed. */
	armedAt?: number;
	preflightAt?: number;
	preflightTurns: number;
	handoff?: string;
	forced?: boolean;
	cooldownAt?: number;
}

export type Decision =
	| { action: "none" }
	| { action: "wait"; why: "safe-point" | "critical-section" }
	| { action: "preflight"; forced?: true }
	| { action: "compact"; why: "threshold" | "manual" | "handoff" | "preflight-turns" | "preflight-budget" | "preflight-settled" | "forced" };

export interface BoundaryInfo {
	criticalSections: number;
	/** Tool calls requested but not yet answered at this boundary. */
	pendingTools?: boolean;
}

export function createController() {
	let s: CycleState = { phase: "idle", preflightTurns: 0 };
	const reset = () => (s = { phase: "idle", preflightTurns: 0 });

	const startOrCompact = (config: CompactorConfig, usage: Usage, forced: boolean): Decision => {
		if (config.preflight.enabled) {
			s = { ...s, phase: "preflight", preflightAt: usage.tokens, preflightTurns: 0, forced };
			return forced ? { action: "preflight", forced: true } : { action: "preflight" };
		}
		s = { ...s, phase: "compacting", forced };
		return { action: "compact", why: forced ? "forced" : s.reason === "manual" ? "manual" : "threshold" };
	};

	return {
		state: (): CycleState => ({ ...s }),

		/** Feed the latest context usage; arms the cycle when the soft threshold is crossed. */
		observe(usage: Usage, config: CompactorConfig): void {
			if (!config.enabled) return;
			if (s.phase === "cooldown") {
				if (usage.tokens - (s.cooldownAt ?? 0) < config.maxDeferTokens) return;
				reset();
			}
			if (s.phase === "idle" && usage.percent >= config.softThreshold) s = { phase: "pending", reason: "threshold", armedAt: usage.tokens, preflightTurns: 0 };
		},

		/** Decide at a turn end or when the agent is about to settle. */
		atBoundary(boundary: Boundary, usage: Usage, config: CompactorConfig, info: BoundaryInfo): Decision {
			if (s.phase === "pending") {
				const forced = usage.percent >= config.hardThreshold || usage.tokens - (s.armedAt ?? usage.tokens) >= config.maxDeferTokens;
				if (forced) return startOrCompact(config, usage, true);
				if (info.criticalSections > 0) return { action: "wait", why: "critical-section" };
				const safe = config.safePoint === "any" || boundary === "settle" || (config.safePoint === "turn" && !info.pendingTools);
				if (!safe) return { action: "wait", why: "safe-point" };
				return startOrCompact(config, usage, false);
			}
			if (s.phase === "preflight") {
				if (boundary === "settle") {
					s = { ...s, phase: "compacting" };
					return { action: "compact", why: "preflight-settled" };
				}
				s = { ...s, preflightTurns: s.preflightTurns + 1 };
				if (usage.tokens - (s.preflightAt ?? usage.tokens) >= config.preflight.budgetTokens) {
					s = { ...s, phase: "compacting" };
					return { action: "compact", why: "preflight-budget" };
				}
				if (s.preflightTurns >= config.preflight.maxTurns) {
					s = { ...s, phase: "compacting" };
					return { action: "compact", why: "preflight-turns" };
				}
			}
			return { action: "none" };
		},

		/** The agent called compaction_ready. */
		ready(handoff: string): Decision {
			if (s.phase !== "preflight") return { action: "none" };
			s = { ...s, phase: "compacting", handoff };
			return { action: "compact", why: "handoff" };
		},

		/** `/compactor now`: start a cycle regardless of thresholds and `enabled`. */
		request(usage: Usage, config: CompactorConfig): Decision {
			if (s.phase === "preflight" || s.phase === "compacting") return { action: "none" };
			s = { phase: "pending", reason: "manual", armedAt: usage.tokens, preflightTurns: 0 };
			return startOrCompact(config, usage, false);
		},

		/** Pi is about to run its own compaction: may we cancel it in favor of our cycle? */
		nativeCompaction(reason: "manual" | "threshold" | "overflow", usage: Usage, config: CompactorConfig): "allow" | "cancel" {
			if (reason !== "threshold" || !config.enabled || s.phase === "compacting") return "allow";
			return usage.percent < config.hardThreshold + (100 - config.hardThreshold) / 2 ? "cancel" : "allow";
		},

		compacted(): void {
			reset();
		},

		failed(usage: Usage): void {
			s = { phase: "cooldown", preflightTurns: 0, cooldownAt: usage.tokens };
		},

		/** User abort: drop pending or preflight work. */
		abort(): void {
			if (s.phase !== "compacting") reset();
		},
	};
}

export type Controller = ReturnType<typeof createController>;
