// Settings files: global `<agentDir>/extensions/pi-compactor/config.json` and project `<cwd>/.pi/compactor.json`.
// Files are storage only; editing goes through `update`, which validates and writes atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkSetting, getPath, setPath, unsetPath, validateLayer, type ConfigLayer } from "./config.ts";

export type Scope = "global" | "project";

export interface StoreOptions {
	/** Pi's agent directory (`getAgentDir()`). */
	agentDir: string;
	cwd: string;
}

export interface Loaded {
	global: ConfigLayer;
	project: ConfigLayer;
	warnings: string[];
}

export type UpdateResult = { ok: true } | { ok: false; error: string };

export interface Store {
	paths: Record<Scope, string>;
	load(): Loaded;
	/** Set `key` (dotted) in `scope`, under `models[model]` when given; `undefined` removes it. */
	update(scope: Scope, key: string, value: unknown, model?: string): UpdateResult;
}

const MODEL_REF = /^[^/\s]+\/\S+$/;

/** Raw parsed file: `{}` when missing; throws on unreadable or invalid JSON. */
function readRaw(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	return text.trim() === "" ? {} : JSON.parse(text);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createStore(options: StoreOptions): Store {
	const paths: Record<Scope, string> = {
		global: join(options.agentDir, "extensions", "pi-compactor", "config.json"),
		project: join(options.cwd, ".pi", "compactor.json"),
	};

	const loadScope = (scope: Scope, warnings: string[]): ConfigLayer => {
		let raw: unknown;
		try {
			raw = readRaw(paths[scope]);
		} catch (error) {
			warnings.push(`${scope}: cannot read ${paths[scope]}: ${message(error)}; ignored`);
			return {};
		}
		const { layer, warnings: found } = validateLayer(raw, scope);
		warnings.push(...found);
		return layer;
	};

	return {
		paths,
		load() {
			const warnings: string[] = [];
			const global = loadScope("global", warnings);
			const project = loadScope("project", warnings);
			return { global, project, warnings };
		},
		update(scope, key, value, model) {
			const invalid = checkSetting(key, value);
			if (invalid && (value !== undefined || invalid.startsWith("unknown"))) return { ok: false, error: invalid };
			if (model !== undefined && !MODEL_REF.test(model)) return { ok: false, error: `model must be provider/modelId (got ${JSON.stringify(model)})` };
			const path = paths[scope];
			let raw: unknown;
			try {
				raw = readRaw(path);
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not a JSON object");
			} catch (error) {
				return { ok: false, error: `cannot update ${path}: ${message(error)}` };
			}
			let next: Record<string, unknown>;
			if (model === undefined) next = value === undefined ? unsetPath(raw, key) : setPath(raw, key, value);
			else {
				const models = (getPath(raw, "models") ?? {}) as Record<string, object>;
				const current = (models[model!] ?? {}) as object;
				const updated = value === undefined ? unsetPath(current, key) : setPath(current, key, value);
				const nextModels: Record<string, object> = { ...models, [model!]: updated };
				if (Object.keys(updated).length === 0) delete nextModels[model!];
				next = { ...(raw as object) };
				if (Object.keys(nextModels).length === 0) delete next.models;
				else next.models = nextModels;
			}
			try {
				mkdirSync(dirname(path), { recursive: true });
				const tmp = `${path}.${process.pid}.tmp`;
				writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
				renameSync(tmp, path);
			} catch (error) {
				return { ok: false, error: `cannot write ${path}: ${message(error)}` };
			}
			return { ok: true };
		},
	};
}
