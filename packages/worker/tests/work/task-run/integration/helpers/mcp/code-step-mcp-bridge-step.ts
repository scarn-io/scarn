/**
 * The code step behind `code-step-mcp-bridge-container.integration.test.ts`.
 * The test bundles this module with the SDK (the container sees only the
 * workspace) and commits the bundle under `.scarn/pipeline-builder/`. The step
 * calls the dependency-free fixture server (`e2e-tool-mcp.mjs`, committed at
 * {@link TOOL_SERVER_PATH}) three times through `context.mcp` and returns the
 * results.
 */
import { codeStep, defineMcp } from "@scarn/sdk/definitions/steps";

export const TOOL_SERVER_PATH = ".scarn/e2e-tool-mcp.mjs";
export const CODE_STEP_KEY = "integration-step";

const tooly = defineMcp({
  type: "local",
  name: "tooly",
  command: ["bun", TOOL_SERVER_PATH],
});

export const bridgeStep = codeStep({
  key: CODE_STEP_KEY,
  name: "Integration Step",
  mcps: { tooly },
  fn: async (_input, { mcp }) => ({
    results: [
      await mcp.tooly.call("lookup", { query: "alpha" }),
      await mcp.tooly.call("lookup", { query: "missing" }),
      await mcp.tooly.call("file_report", { title: "Weekly" }),
    ],
  }),
});
