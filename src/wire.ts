// Wiring: connects the core to Pi's extension API. Type-only Pi imports, so it runs under plain `node --test`;
// runtime values (agent dir, TUI components) are injected by extensions/compactor.ts.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig, type CompactorConfig } from "./config.ts";
import { createStore, type Store } from "./store.ts";

export interface WireOptions {
	agentDir: string;
	/** Where notices go without a UI (print/JSON/RPC); stdout stays free for Pi's output. */
	stderr?: (text: string) => void;
}

export interface Settings {
	/** Config for the current cwd and model; re-read from disk so edits apply without reload. */
	current(): CompactorConfig;
	store(): Store;
	warnings(): string[];
}

type Ctx = Pick<ExtensionContext, "cwd" | "hasUI" | "ui" | "model">;

export const modelKey = (model: { provider: string; id: string } | undefined) => (model ? `${model.provider}/${model.id}` : undefined);

export function registerCompactor(pi: ExtensionAPI, options: WireOptions): Settings {
	const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
	let ctx: Ctx | undefined;
	let model: string | undefined;
	let lastWarnings = "";
	let warnings: string[] = [];

	const store = () => createStore({ agentDir: options.agentDir, cwd: ctx?.cwd ?? process.cwd() });
	const notify = (text: string, type: "info" | "warning" | "error" = "info") => {
		if (ctx?.hasUI) ctx.ui.notify(text, type);
		else stderr(`[compactor] ${text}\n`);
	};
	const current = () => {
		const loaded = store().load();
		const resolved = resolveConfig({ global: loaded.global, project: loaded.project, model });
		warnings = [...loaded.warnings, ...resolved.warnings];
		const key = warnings.join("\n");
		if (key !== lastWarnings) {
			lastWarnings = key;
			if (warnings.length > 0) notify(`settings adjusted:\n${warnings.join("\n")}`, "warning");
		}
		return resolved.config;
	};

	pi.on("session_start", (_event, c) => {
		ctx = c;
		model = modelKey(c.model);
		current();
	});
	pi.on("model_select", (event, c) => {
		ctx = c;
		model = modelKey(event.model);
		current();
	});

	return { current, store, warnings: () => warnings };
}
