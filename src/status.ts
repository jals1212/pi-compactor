// Footer status indicator, always on: the cycle phase and usage while a compaction runs, "off" when automatic
// compaction is disabled, otherwise our own distance to the soft threshold of the current model.
import type { Phase } from "./controller.ts";

export const STATUS_KEY = "compactor";
/** Footer prefix: the press with emoji presentation (U+FE0F); pi-tui measures it as 2 cells, like 🪐. */
export const BRAND = "🗜️";

export interface StatusView {
	phase: Phase;
	/** Usage percent the cycle last observed; shown with the phase while a cycle runs. */
	percent?: number;
	enabled: boolean;
	softThreshold: number;
	/** Pi's current usage; undefined when Pi reports none (for example right after a compaction). */
	usage?: { tokens: number; percent: number; contextWindow: number };
}

/** Tokens as `999`, `620k` or `1.2M`. */
export function formatTokens(tokens: number): string {
	const n = Math.round(tokens);
	if (n < 1000) return String(n);
	if (n < 999_500) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Text for the footer. */
export function statusText(view: StatusView): string {
	if (view.phase !== "idle") return view.percent === undefined ? `${BRAND} ${view.phase}` : `${BRAND} ${view.phase} ${Math.round(view.percent)}%`;
	if (!view.enabled) return `${BRAND} off`;
	const { usage } = view;
	if (!usage || usage.contextWindow <= 0) return BRAND;
	const distance = Math.max(0, (view.softThreshold / 100) * usage.contextWindow - usage.tokens);
	// Idle at or past the threshold (pruning, or the cycle has not armed yet): no distance left, show the usage.
	if (Math.round(distance) === 0) return `${BRAND} due ${Math.round(usage.percent)}%`;
	return `${BRAND} ${formatTokens(distance)} to compact`;
}

export interface Status {
	update(view: StatusView): void;
}

/** Calls `set` only when the text changes, so every boundary can report without flooding the footer. */
export function createStatus(set: (text: string | undefined) => void): Status {
	let shown: string | undefined;
	return {
		update(view) {
			const text = statusText(view);
			if (text === shown) return;
			shown = text;
			set(text);
		},
	};
}
