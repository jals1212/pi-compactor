// Agnostic extension protocol over `pi.events` plus the preflight message template. This package names no other
// extension: anyone may listen or emit on these channels.
//
// compactor:collect  emitted by us before preflight. Payload { reason, strategy, contribute(c) }; listeners call
//                    contribute({ source, steps?: string[], handoff?: string }) synchronously.
// compactor:defer    emitted by others: { source, active: boolean, reason? } opens/closes a critical section.
// compactor:done     emitted by us after a compaction with its metrics.

export const CHANNELS = { collect: "compactor:collect", defer: "compactor:defer", done: "compactor:done" } as const;

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface Contribution {
	source: string;
	/** Extra preflight checklist items for the agent. */
	steps?: string[];
	/** Text added verbatim to the handoff that survives compaction. */
	handoff?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function checkContribution(raw: unknown): Contribution | string {
	if (typeof raw !== "object" || raw === null) return "ignored contribution: not an object";
	const c = raw as Record<string, unknown>;
	if (typeof c.source !== "string" || c.source.trim() === "") return "ignored contribution: source must be a non-empty string";
	const out: Contribution = { source: c.source };
	if (c.steps !== undefined) {
		if (!Array.isArray(c.steps) || c.steps.some((s) => typeof s !== "string")) return `ignored contribution from ${c.source}: steps must be a list of strings`;
		const steps = (c.steps as string[]).map((s) => s.trim()).filter(Boolean);
		if (steps.length > 0) out.steps = steps;
	}
	if (c.handoff !== undefined) {
		if (typeof c.handoff !== "string") return `ignored contribution from ${c.source}: handoff must be a string`;
		if (c.handoff.trim()) out.handoff = c.handoff;
	}
	return out;
}

export function collectContributions(bus: EventBus, info: { reason: string; strategy: string }): { contributions: Contribution[]; warnings: string[] } {
	const contributions: Contribution[] = [];
	const warnings: string[] = [];
	let open = true;
	const payload = {
		...info,
		contribute(raw: unknown) {
			if (!open) return;
			const checked = checkContribution(raw);
			if (typeof checked === "string") warnings.push(checked);
			else contributions.push(checked);
		},
	};
	// Pi's bus isolates and logs listener errors; listeners must contribute synchronously, before any await.
	try {
		bus.emit(CHANNELS.collect, payload);
	} catch (error) {
		warnings.push(`a ${CHANNELS.collect} listener failed: ${message(error)}`);
	}
	open = false;
	return { contributions, warnings };
}

export interface CriticalSection {
	source: string;
	reason?: string;
}

export interface CriticalSections {
	set(source: string, active: boolean, reason?: string): void;
	active(): CriticalSection[];
	clear(): void;
	dispose(): void;
}

export function createCriticalSections(bus: EventBus): CriticalSections {
	const open = new Map<string, string | undefined>();
	const set = (source: string, active: boolean, reason?: string) => {
		if (active) open.set(source, reason);
		else open.delete(source);
	};
	const off = bus.on(CHANNELS.defer, (data) => {
		if (typeof data !== "object" || data === null) return;
		const d = data as Record<string, unknown>;
		if (typeof d.source !== "string" || typeof d.active !== "boolean") return;
		set(d.source, d.active, typeof d.reason === "string" ? d.reason : undefined);
	});
	return {
		set,
		active: () => [...open].map(([source, reason]) => (reason === undefined ? { source } : { source, reason })),
		clear: () => open.clear(),
		dispose: off,
	};
}

export const DEFAULT_TEMPLATE = `[compactor] Context is at {{percent}}% ({{reason}}); it will be compacted soon (strategy: {{strategy}}).
Before that, finish or pause safely and hand off your state:
- Do not start new long operations; finish the current step if it is short.
- Save anything that must persist (files, notes) now.
{{steps}}
Then call the compaction_ready tool once with a handoff: the goal, what is done, what is in progress, next steps,
key decisions and constraints, and files involved. Everything not in the handoff may be lost.`;

export function renderPreflight(input: { template: string | null; strategy: string; reason: string; percent: number; steps: Contribution[] }): string {
	const lines = input.steps.flatMap((c) => (c.steps ?? []).map((s) => `- ${s} (from ${c.source})`));
	const values: Record<string, string> = {
		percent: String(Math.round(input.percent)),
		reason: input.reason,
		strategy: input.strategy,
		steps: lines.length > 0 ? lines.join("\n") : "(none)",
	};
	const template = input.template ?? DEFAULT_TEMPLATE;
	const out = template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
	// The built-in template has its own steps list; drop the empty marker there.
	return input.template === null ? out.replace(/\n\(none\)\n/, "\n") : out;
}
