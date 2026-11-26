// Footer status indicator: shows the cycle phase and usage while a compaction is in progress, nothing when idle.
import type { Phase } from "./controller.ts";

export const STATUS_KEY = "compactor";

/** Text for the footer, or undefined when idle. */
export function statusText(phase: Phase, percent: number | undefined): string | undefined {
	if (phase === "idle") return undefined;
	return percent === undefined ? `compactor: ${phase}` : `compactor: ${phase} ${Math.round(percent)}%`;
}

export interface Status {
	update(phase: Phase, percent: number | undefined): void;
}

/** Calls `set` only when the text changes, so every boundary can report without flooding the footer. */
export function createStatus(set: (text: string | undefined) => void): Status {
	let shown: string | undefined;
	return {
		update(phase, percent) {
			const text = statusText(phase, percent);
			if (text === shown) return;
			shown = text;
			set(text);
		},
	};
}
