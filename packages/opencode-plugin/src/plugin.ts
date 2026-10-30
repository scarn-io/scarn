import type { Plugin } from "@opencode/plugin";
import { createScarnEndConversationTool } from "./tools/scarn-end-conversation";
import { createScarnSubmitArtifactTool } from "./tools/scarn-submit-artifact";
import { createScarnSubmitStepFindingsTool } from "./tools/scarn-submit-step-findings";
import { createPlaywrightTraceAnalyzerTool } from "./tools/playwright-trace-analyzer";
import { SCARN_RPC_DEFINITION, describeRegisteredTools } from "./scarn-rpc";

/**
 * The Scarn OpenCode plugin: registers Scarn's tools, and exposes a
 * `scarn.listTools` RPC so the worker can enumerate registered tool ids and
 * input schemas (v2 has no server route for that).
 *
 * A plain object rather than `Plugin.define(...)`: `define` is an identity
 * function, and avoiding the runtime import keeps the bundled
 * `.opencode/plugins/scarn.js` free of any module it would have to resolve
 * from the user's workspace.
 */
const ScarnOpencodePlugin: Plugin.Plugin = {
  id: "scarn",
  async setup(ctx) {
    const submitArtifactTool = await createScarnSubmitArtifactTool(
      ctx.location.directory,
    );
    await ctx.tool.transform((editor) => {
      editor.add(createScarnSubmitStepFindingsTool(ctx.location.directory));
      editor.add(createScarnEndConversationTool(ctx.location.directory));
      editor.add(submitArtifactTool);
      editor.add(createPlaywrightTraceAnalyzerTool());
    });
    await ctx.rpc.register(SCARN_RPC_DEFINITION, {
      listTools: async () => ({
        tools: describeRegisteredTools(await ctx.tool.list()),
      }),
    });
  },
};

export default ScarnOpencodePlugin;
