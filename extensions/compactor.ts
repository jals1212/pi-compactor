// pi-compactor: phased context compaction (preflight handoff, safe points, strategies, pins, pruning).
import { convertToLlm, getAgentDir, serializeConversation, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactor } from "../src/wire.ts";

export default function (pi: ExtensionAPI) {
	registerCompactor(pi, { agentDir: getAgentDir(), convertToLlm, serializeConversation });
}
