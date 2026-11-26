// pi-compactor: phased context compaction (preflight handoff, safe points, strategies, pins, pruning).
import { convertToLlm, estimateTokens, getAgentDir, serializeConversation, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCompactor } from "../src/wire.ts";

/** Pi's `compaction.keepRecentTokens` as Pi resolves it for this cwd and model. */
const keepRecentTokens = (ctx: ExtensionContext) => SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionSettings(ctx.model as never).keepRecentTokens;

export default function (pi: ExtensionAPI) {
	registerCompactor(pi, { agentDir: getAgentDir(), convertToLlm, serializeConversation, estimateTokens, keepRecentTokens });
}
