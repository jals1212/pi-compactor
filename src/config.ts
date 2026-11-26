// Configuration schema, validation and layered resolution: defaults < global < project < global model < project model.
// Pure: no file access here (see store.ts), so it runs under plain `node --test`.

export type Strategy = "summary" | "hybrid" | "handoff-only";
export type SafePoint = "settle" | "turn" | "any";

export interface CompactorConfig {
	/** Master switch for automatic compaction (manual `/compactor now` still works). */
	enabled: boolean;
	/** Percent of the context window that starts a compaction cycle (preflight, then compact). */
	softThreshold: number;
	/** Percent at which compaction no longer waits for a safe point. */
	hardThreshold: number;
	strategy: Strategy;
	/** When a pending compaction may run: `settle` (agent idle), `turn` (between turns), `any`. */
	safePoint: SafePoint;
	/** Most tokens the context may grow while compaction waits for a safe point or a critical section. */
	maxDeferTokens: number;
	/** Model for summaries as `provider/modelId`; null uses the session model. */
	summaryModel: string | null;
	preflight: {
		enabled: boolean;
		maxTurns: number;
		budgetTokens: number;
		/** Preflight instructions; null uses the built-in template. */
		template: string | null;
	};
	pruning: {
		enabled: boolean;
		/** Tool results at least this large (tokens) may be pruned. */
		minToolResultTokens: number;
		/** Turns at the end of the context whose tool results are never pruned. */
		keepRecentTurns: number;
	};
	pins: {
		originalRequest: boolean;
		userCorrections: boolean;
		maxTokens: number;
	};
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type ConfigValues = DeepPartial<CompactorConfig>;
export interface ConfigLayer extends ConfigValues {
	/** Overrides per model, keyed `provider/modelId`. */
	models?: Record<string, ConfigValues>;
}

export const DEFAULTS: CompactorConfig = {
	enabled: true,
	softThreshold: 70,
	hardThreshold: 90,
	strategy: "hybrid",
	safePoint: "settle",
	maxDeferTokens: 20_000,
	summaryModel: null,
	preflight: { enabled: true, maxTurns: 3, budgetTokens: 8_000, template: null },
	pruning: { enabled: true, minToolResultTokens: 2_000, keepRecentTurns: 3 },
	pins: { originalRequest: true, userCorrections: true, maxTokens: 4_000 },
};

type Kind =
	| { type: "number"; min: number; max: number }
	| { type: "enum"; values: readonly string[] }
	| { type: "boolean" }
	| { type: "model" }
	| { type: "text" };

export interface Field {
	key: string;
	kind: Kind;
	description: string;
}

const MODEL_REF = /^[^/\s]+\/\S+$/;

/** Every setting, in display order; the TUI and validation are driven by this table. */
export const FIELDS: readonly Field[] = [
	{ key: "enabled", kind: { type: "boolean" }, description: "Compact automatically" },
	{ key: "softThreshold", kind: { type: "number", min: 1, max: 99 }, description: "Context % that starts preflight + compaction" },
	{ key: "hardThreshold", kind: { type: "number", min: 2, max: 100 }, description: "Context % that stops waiting for a safe point" },
	{ key: "strategy", kind: { type: "enum", values: ["summary", "hybrid", "handoff-only"] }, description: "What survives compaction" },
	{ key: "safePoint", kind: { type: "enum", values: ["settle", "turn", "any"] }, description: "When a pending compaction may run" },
	{ key: "maxDeferTokens", kind: { type: "number", min: 0, max: 1_000_000 }, description: "Max growth (tokens) while waiting" },
	{ key: "summaryModel", kind: { type: "model" }, description: "provider/modelId for summaries (empty: session model)" },
	{ key: "preflight.enabled", kind: { type: "boolean" }, description: "Ask the agent for a handoff before compacting" },
	{ key: "preflight.maxTurns", kind: { type: "number", min: 1, max: 20 }, description: "Max agent turns for preflight" },
	{ key: "preflight.budgetTokens", kind: { type: "number", min: 500, max: 200_000 }, description: "Max tokens preflight may add" },
	{ key: "preflight.template", kind: { type: "text" }, description: "Preflight instructions (empty: built-in)" },
	{ key: "pruning.enabled", kind: { type: "boolean" }, description: "Prune old large tool results first" },
	{ key: "pruning.minToolResultTokens", kind: { type: "number", min: 100, max: 1_000_000 }, description: "Min tool result size to prune (tokens)" },
	{ key: "pruning.keepRecentTurns", kind: { type: "number", min: 0, max: 100 }, description: "Recent turns never pruned" },
	{ key: "pins.originalRequest", kind: { type: "boolean" }, description: "Keep the original request verbatim" },
	{ key: "pins.userCorrections", kind: { type: "boolean" }, description: "Keep user corrections verbatim" },
	{ key: "pins.maxTokens", kind: { type: "number", min: 0, max: 100_000 }, description: "Max tokens for pins" },
];

const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const GROUPS = new Set(FIELDS.filter((f) => f.key.includes(".")).map((f) => f.key.split(".")[0]));

export function describeKind(kind: Kind): string {
	switch (kind.type) {
		case "number":
			return `a number from ${kind.min} to ${kind.max}`;
		case "enum":
			return `one of ${kind.values.join(", ")}`;
		case "boolean":
			return "true or false";
		case "model":
			return "provider/modelId or null";
		case "text":
			return "text or null";
	}
}

function checkValue(field: Field, value: unknown): string | undefined {
	const k = field.kind;
	const ok =
		(k.type === "number" && typeof value === "number" && Number.isFinite(value) && value >= k.min && value <= k.max) ||
		(k.type === "enum" && typeof value === "string" && k.values.includes(value)) ||
		(k.type === "boolean" && typeof value === "boolean") ||
		(k.type === "model" && (value === null || (typeof value === "string" && MODEL_REF.test(value)))) ||
		(k.type === "text" && (value === null || typeof value === "string"));
	return ok ? undefined : `${field.key} must be ${describeKind(k)} (got ${JSON.stringify(value)})`;
}

/** Why `value` is not valid for `key`, or undefined when it is. */
export function checkSetting(key: string, value: unknown): string | undefined {
	const field = FIELD_BY_KEY.get(key);
	return field ? checkValue(field, value) : `unknown setting ${key}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validateValues(raw: Record<string, unknown>, scope: string, warnings: string[], allowModels: boolean): ConfigLayer {
	const out: ConfigLayer = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "models" && allowModels) continue;
		if (GROUPS.has(key)) {
			if (!isObject(value)) {
				warnings.push(`${scope}: ${key} must be an object; ignored`);
				continue;
			}
			for (const [sub, subValue] of Object.entries(value)) {
				const field = FIELD_BY_KEY.get(`${key}.${sub}`);
				if (!field) warnings.push(`${scope}: unknown setting ${key}.${sub}; ignored`);
				else {
					const error = checkValue(field, subValue);
					if (error) warnings.push(`${scope}: ${error}; ignored`);
					else Object.assign(out, setPath(out, field.key, subValue));
				}
			}
			continue;
		}
		const field = FIELD_BY_KEY.get(key);
		if (!field) {
			warnings.push(`${scope}: unknown setting ${key}; ignored`);
			continue;
		}
		const error = checkValue(field, value);
		if (error) warnings.push(`${scope}: ${error}; ignored`);
		else (out as Record<string, unknown>)[key] = value;
	}
	return out;
}

/** Keep the valid part of one file's contents; everything dropped is reported as a warning. */
export function validateLayer(raw: unknown, scope: string): { layer: ConfigLayer; warnings: string[] } {
	const warnings: string[] = [];
	if (!isObject(raw)) {
		warnings.push(`${scope}: settings must be a JSON object; ignored`);
		return { layer: {}, warnings };
	}
	const layer = validateValues(raw, scope, warnings, true);
	if ("models" in raw) {
		if (!isObject(raw.models)) warnings.push(`${scope}: models must be an object; ignored`);
		else {
			layer.models = {};
			for (const [model, values] of Object.entries(raw.models)) {
				if (!MODEL_REF.test(model)) warnings.push(`${scope}: model key ${JSON.stringify(model)} must be provider/modelId; ignored`);
				else if (!isObject(values)) warnings.push(`${scope} model ${model}: overrides must be an object; ignored`);
				else {
					const valid = validateValues(values, `${scope} model ${model}`, warnings, false);
					if (Object.keys(valid).length > 0) layer.models[model] = valid;
				}
			}
		}
	}
	return { layer, warnings };
}

function merge<T>(base: T, over: unknown): T {
	if (!isObject(over)) return base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over)) {
		if (k === "models" || v === undefined) continue;
		out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v;
	}
	return out as T;
}

export interface ResolveInput {
	global?: unknown;
	project?: unknown;
	/** `provider/modelId` of the session model, when known. */
	model?: string;
}

export interface Resolved {
	config: CompactorConfig;
	warnings: string[];
}

export function resolveConfig(input: ResolveInput): Resolved {
	const global = validateLayer(input.global ?? {}, "global");
	const project = validateLayer(input.project ?? {}, "project");
	const warnings = [...global.warnings, ...project.warnings];
	let config = merge(merge(DEFAULTS, global.layer), project.layer);
	if (input.model) config = merge(merge(config, global.layer.models?.[input.model]), project.layer.models?.[input.model]);
	if (config.softThreshold >= config.hardThreshold) {
		const adjusted = Math.max(1, config.hardThreshold - 5);
		warnings.push(`softThreshold ${config.softThreshold} is not below hardThreshold ${config.hardThreshold}; using ${adjusted}`);
		config = { ...config, softThreshold: adjusted };
	}
	return { config, warnings };
}

export function getPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) cur = isObject(cur) ? cur[part] : undefined;
	return cur;
}

/** Copy of `obj` with `path` set; inputs are never mutated. */
export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
	const [head, ...rest] = path.split(".");
	const src = obj as Record<string, unknown>;
	const next = rest.length === 0 ? value : setPath(isObject(src[head]) ? src[head] : {}, rest.join("."), value);
	return { ...src, [head]: next } as T;
}

/** Copy of `obj` without `path`; empty parent objects are removed. */
export function unsetPath<T extends object>(obj: T, path: string): T {
	const [head, ...rest] = path.split(".");
	const out = { ...(obj as Record<string, unknown>) };
	if (rest.length === 0) delete out[head];
	else if (isObject(out[head])) {
		const child = unsetPath(out[head], rest.join("."));
		if (Object.keys(child).length === 0) delete out[head];
		else out[head] = child;
	}
	return out as T;
}

/** Convert user-typed text into a valid value for `key`. Empty text means null for nullable keys. */
export function parseValue(key: string, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const field = FIELD_BY_KEY.get(key);
	if (!field) return { ok: false, error: `unknown setting ${key}` };
	const t = text.trim();
	let value: unknown = text;
	switch (field.kind.type) {
		case "number":
			value = t === "" ? Number.NaN : Number(t);
			if (Number.isNaN(value)) return { ok: false, error: `${key} must be ${describeKind(field.kind)} (got ${JSON.stringify(text)})` };
			break;
		case "boolean":
			value = t === "true" ? true : t === "false" ? false : t;
			break;
		case "model":
			value = t === "" ? null : t;
			break;
		case "text":
			value = text === "" ? null : text;
			break;
		case "enum":
			value = t;
			break;
	}
	const error = checkValue(field, value);
	return error ? { ok: false, error } : { ok: true, value };
}
