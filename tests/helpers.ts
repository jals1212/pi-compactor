// Fake Pi extension API: records handlers, tools, commands, messages, events and UI calls; tests fire events through it.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CompactCall {
	options: { customInstructions?: string; onComplete?: (r: unknown) => void; onError?: (e: Error) => void };
}

export interface Completion {
	model: unknown;
	context: { messages: { role: string; content: { type: string; text: string }[]; timestamp: number }[] };
	options: { maxTokens?: number; signal?: AbortSignal; cacheRetention?: string; sessionId?: string };
}

export interface FakeResponse {
	content: { type: string; text?: string }[];
	stopReason: string;
	usage?: unknown;
	errorMessage?: string;
}

export const reply = (text: string, over: Partial<FakeResponse> = {}): FakeResponse => ({
	content: [{ type: "text", text }],
	stopReason: "stop",
	usage: { input: 10, output: 5 },
	...over,
});

export interface FakeCtx {
	cwd: string;
	hasUI: boolean;
	model: { provider: string; id: string; contextWindow?: number } | undefined;
	ui: { notify(text: string, type?: string): void; setStatus(key: string, text: string | undefined): void };
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	compact(options?: CompactCall["options"]): void;
	isIdle(): boolean;
	modelRegistry: { find(provider: string, id: string): unknown; complete(model: unknown, context: Completion["context"], options: Completion["options"]): Promise<FakeResponse> };
	[key: string]: unknown;
}

export interface FakePi {
	pi: any;
	handlers: Map<string, ((event: any, ctx: any) => unknown)[]>;
	tools: Map<string, any>;
	commands: Map<string, any>;
	notes: [string, string | undefined][];
	statuses: [string, string | undefined][];
	stderr: string[];
	sent: [any, any][];
	emitted: [string, unknown][];
	compacts: CompactCall[];
	/** Calls to ctx.modelRegistry.complete, in order. */
	completions: Completion[];
	/** Models ctx.modelRegistry.find knows, keyed `provider/id`. */
	registry: Map<string, unknown>;
	/** What ctx.modelRegistry.complete answers next; a function receives the call. */
	setReply(next: FakeResponse | Error | ((call: Completion) => FakeResponse)): void;
	ctx: FakeCtx;
	agentDir: string;
	/** Set the context usage percent the next events will report (window 100k tokens). */
	setPercent(percent: number | null): void;
	fire(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
	/** Run a registered tool through its execute(). */
	tool(name: string, params: Record<string, unknown>): Promise<any>;
	emit(channel: string, data: unknown): void;
}

export const WINDOW = 100_000;

export function fakePi(options: { hasUI?: boolean; model?: FakeCtx["model"] } = {}): FakePi {
	const root = mkdtempSync(join(tmpdir(), "compactor-wire-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notes: [string, string | undefined][] = [];
	const statuses: [string, string | undefined][] = [];
	const stderr: string[] = [];
	const sent: [any, any][] = [];
	const emitted: [string, unknown][] = [];
	const compacts: CompactCall[] = [];
	const completions: Completion[] = [];
	const registry = new Map<string, unknown>();
	let next: FakeResponse | Error | ((call: Completion) => FakeResponse) = reply("SUMMARY");
	let percent: number | null = 10;
	const ctx: FakeCtx = {
		cwd,
		hasUI: options.hasUI ?? true,
		model: "model" in options ? options.model : { provider: "anthropic", id: "opus", contextWindow: WINDOW },
		ui: { notify: (text, type) => void notes.push([text, type]), setStatus: (key, text) => void statuses.push([key, text]) },
		getContextUsage: () => ({ tokens: percent === null ? null : (percent / 100) * WINDOW, contextWindow: WINDOW, percent }),
		compact: (o = {}) => void compacts.push({ options: o }),
		isIdle: () => true,
		modelRegistry: {
			find: (provider, id) => registry.get(`${provider}/${id}`),
			async complete(model, context, opts) {
				const call = { model, context, options: opts };
				completions.push(call);
				if (next instanceof Error) throw next;
				return typeof next === "function" ? next(call) : next;
			},
		},
	};
	const emit = (channel: string, data: unknown) => {
		emitted.push([channel, data]);
		for (const l of listeners.get(channel) ?? []) {
			try {
				l(data);
			} catch {}
		}
	};
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerTool: (def: any) => void tools.set(def.name, def),
		registerCommand: (name: string, def: any) => void commands.set(name, def),
		sendMessage: (message: any, opts: any) => void sent.push([message, opts]),
		events: {
			emit,
			on(channel: string, handler: (data: unknown) => void) {
				listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
				return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== handler));
			},
		},
	};
	return {
		pi,
		handlers,
		tools,
		commands,
		notes,
		statuses,
		stderr,
		sent,
		emitted,
		compacts,
		completions,
		registry,
		setReply: (r) => void (next = r),
		ctx,
		agentDir,
		setPercent: (p) => void (percent = p),
		async fire(event, payload = {}) {
			const results = [];
			for (const h of handlers.get(event) ?? []) results.push(await h({ type: event, ...payload }, ctx));
			return results;
		},
		async tool(name, params) {
			return tools.get(name).execute("call-1", params, undefined, undefined, ctx);
		},
		emit,
	};
}
