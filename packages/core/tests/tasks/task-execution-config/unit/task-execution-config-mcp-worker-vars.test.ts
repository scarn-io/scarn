import { expect, test } from "bun:test";
import { readStoredTaskExecutionConfig } from "@/tasks/task-execution-config/contracts/task-execution-config-stored";

test("all stored versions preserve additive MCP metadata without current write refinements", () => {
  const workerVars = [
    {
      source: "inherit" as const,
      name: "SCARN_HISTORICAL",
      from: "SCARN_OLD",
      secret: true,
      optional: false,
      default: "historical",
      applies: "agent" as const,
    },
  ];
  for (const version of [1, 2, 3]) {
    for (const server of [
      { type: "ref" as const, name: "" },
      { type: "local" as const, command: [] },
      { type: "remote" as const, url: "" },
    ]) {
      const mcpJson = { api: { ...server, workerVars } };
      const common = { gitJson: null, mcpJson, healthChecksJson: null };
      const result = readStoredTaskExecutionConfig(
        version,
        version === 3
          ? { ...common, environmentJson: null }
          : { ...common, runtimeJson: null, envJson: null },
      );
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.reason);
      expect(result.content.mcp).toEqual(mcpJson);
    }
  }
});
