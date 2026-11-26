// Fake Pi extension API: records handlers, commands, tools and UI calls; tests fire events through it.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCtx {
	cwd: string;
	hasUI: boolean;
	model: { provider: string; id: string; contextWindow?: number } | undefined;
	ui: { notify(text: string, type?: string): void; setStatus(key: string, text: string | undefined): void };
	[key: string]: unknown;
}

export interface FakePi {
	pi: any;
	handlers: Map<string, ((event: any, ctx: any) => unknown)[]>;
	notes: [string, string | undefined][];
	stderr: string[];
	ctx: FakeCtx;
	agentDir: string;
	fire(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
}

export function fakePi(options: { hasUI?: boolean; model?: FakeCtx["model"] } = {}): FakePi {
	const root = mkdtempSync(join(tmpdir(), "compactor-wire-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
	const notes: [string, string | undefined][] = [];
	const stderr: string[] = [];
	const ctx: FakeCtx = {
		cwd,
		hasUI: options.hasUI ?? true,
		model: "model" in options ? options.model : { provider: "anthropic", id: "opus", contextWindow: 200_000 },
		ui: { notify: (text, type) => void notes.push([text, type]), setStatus: () => {} },
	};
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
	};
	return {
		pi,
		handlers,
		notes,
		stderr,
		ctx,
		agentDir,
		async fire(event, payload = {}) {
			const results = [];
			for (const h of handlers.get(event) ?? []) results.push(await h({ type: event, ...payload }, ctx));
			return results;
		},
	};
}
