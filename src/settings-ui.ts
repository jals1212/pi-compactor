// TUI settings editor (`/compactor settings`): pick a scope (global, project, or the current model in either file),
// then view and edit every setting with Pi's dialogs (select, input, editor). Files are storage only; every write goes
// through the store, which validates, and every typed value through `parseValue`, whose error is shown as feedback.
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describeKind, FIELDS, getPath, parseValue, type CompactorConfig, type Field } from "./config.ts";
import type { Scope, Store } from "./store.ts";

export interface SettingsDeps {
	store(): Store;
	/** Resolved config for the session model; also reports settings warnings. */
	current(): CompactorConfig;
	/** `provider/modelId` of the current model, when known. */
	model: string | undefined;
	say(text: string, level?: "info" | "warning" | "error"): void;
}

export type SettingsCtx = { ui: Pick<ExtensionUIContext, "select" | "input" | "editor"> };

interface ScopeChoice {
	label: string;
	/** Short name used in rows and messages. */
	name: string;
	scope: Scope;
	model?: string;
}

const RESET = "Reset (inherit)";
const CANCEL = "Cancel";
const EDIT = "Edit value";
const CHANGE_SCOPE = "Change scope…";
const DONE = "Done";

const EMPTY: Record<string, string> = { "preflight.template": "built-in", summaryModel: "session model" };

function show(key: string, value: unknown): string {
	if (value === null || value === undefined) return EMPTY[key] ?? "empty";
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : String(value);
	return text.length > 30 ? `${text.slice(0, 29)}…` : text;
}

const scopeChoices = (model: string | undefined): ScopeChoice[] => [
	{ label: "global", name: "global", scope: "global" },
	{ label: "project", name: "project", scope: "project" },
	...(model
		? [
				{ label: `model ${model} (global file)`, name: "model", scope: "global" as const, model },
				{ label: `model ${model} (project file)`, name: "model", scope: "project" as const, model },
			]
		: []),
];

export async function runSettingsEditor(ctx: SettingsCtx, deps: SettingsDeps): Promise<void> {
	const { ui } = ctx;
	const choices = scopeChoices(deps.model);

	const ownValue = (choice: ScopeChoice, key: string): unknown => {
		const layer = deps.store().load()[choice.scope];
		return getPath(choice.model ? layer.models?.[choice.model] : layer, key);
	};
	const where = (choice: ScopeChoice) => (`${choice.model ? `model ${choice.model}, ` : ""}${choice.scope}: ${deps.store().paths[choice.scope]}`);

	const save = (choice: ScopeChoice, field: Field, value: unknown | undefined): boolean => {
		const result = deps.store().update(choice.scope, field.key, value, choice.model);
		if (!result.ok) {
			deps.say(result.error, "error");
			return false;
		}
		deps.current();
		deps.say(value === undefined ? `reset ${field.key} (${where(choice)})` : `saved ${field.key} = ${show(field.key, value)} (${where(choice)})`);
		return true;
	};

	const edit = async (choice: ScopeChoice, field: Field): Promise<void> => {
		const title = `${field.key}: ${field.description} [${choice.label}]`;
		const own = ownValue(choice, field.key);
		const effective = getPath(deps.current(), field.key);
		const kind = field.kind;
		if (kind.type === "boolean" || kind.type === "enum") {
			const values = kind.type === "boolean" ? ["true", "false"] : [...kind.values];
			const answer = await ui.select(title, [...values, RESET, CANCEL]);
			if (answer === undefined || answer === CANCEL) return;
			if (answer === RESET) {
				save(choice, field, undefined);
				return;
			}
			const parsed = parseValue(field.key, answer);
			if (!parsed.ok) deps.say(parsed.error, "error");
			else save(choice, field, parsed.value);
			return;
		}
		const action = await ui.select(`${title} (${describeKind(kind)})`, [EDIT, RESET, CANCEL]);
		if (action === RESET) {
			save(choice, field, undefined);
			return;
		}
		if (action !== EDIT) return;
		const initial = String(own ?? effective ?? "");
		for (;;) {
			const text = kind.type === "text" ? await ui.editor(title, initial) : await ui.input(`${title} (${describeKind(kind)})`, initial);
			if (text === undefined) return;
			const parsed = parseValue(field.key, text);
			if (!parsed.ok) {
				deps.say(parsed.error, "error");
				continue;
			}
			save(choice, field, parsed.value);
			return;
		}
	};

	for (;;) {
		const label = await ui.select("Compactor settings: scope", choices.map((c) => c.label));
		const choice = choices.find((c) => c.label === label);
		if (!choice) return;
		for (;;) {
			const config = deps.current();
			const rows = FIELDS.map((f) => {
				const own = ownValue(choice, f.key);
				return `${f.key} = ${show(f.key, getPath(config, f.key))} · ${choice.name}: ${own === undefined ? "inherit" : show(f.key, own)}`;
			});
			const answer = await ui.select(`Compactor settings: scope: ${choice.label}`, [...rows, CHANGE_SCOPE, DONE]);
			if (answer === undefined || answer === DONE) return;
			if (answer === CHANGE_SCOPE) break;
			const index = rows.indexOf(answer);
			if (index >= 0) await edit(choice, FIELDS[index]);
		}
	}
}
