import { describe, expect, test } from "bun:test";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import {
  MissingStepEnvError,
  planStepEnv,
  withInferredMcpEnv,
} from "../../../../src/work/task-run/application/resolve-step-env";

const declaration = (name: string, optional = false) => ({
  source: "inherit" as const,
  name,
  from: name,
  optional,
  secret: true,
  applies: "agent" as const,
});

describe("per-server workerVars", () => {
  test("inline metadata resolves without refs and preserves inheritance details", () => {
    const plan = planStepEnv({
      envVars: null,
      inputJson: {},
      workerEnv: { HOST_KEY: "private-key" },
      opencodeMcpJson: {
        api: {
          type: "remote",
          url: "https://example.com",
          workerVars: [
            { ...declaration("KEY"), from: "HOST_KEY" },
            { ...declaration("REGION"), secret: false, default: "us" },
            declaration("OPTIONAL", true),
          ],
        },
      },
    });
    expect(plan.resolveMcpEnv).toBeUndefined();
    expect(plan.resolved).toEqual({
      stepEnv: { KEY: "private-key", REGION: "us" },
      setupEnv: {},
      promptEnv: { REGION: "us" },
      secretValues: ["private-key"],
      mcpOnlyEnvNames: ["KEY", "REGION", "OPTIONAL"],
    });
  });

  test("an optional declaration suppresses inference only on its own server", () => {
    const servers: OpenCodeMcpServers = {
      a: { type: "ref", workerVars: [declaration("TOKEN", true)] },
      b: { type: "ref" },
    };
    expect(
      withInferredMcpEnv(null, [{ key: "a", requiredEnv: ["TOKEN"] }], servers),
    ).toEqual([{ ...declaration("TOKEN", true), mcp: "a" }]);
    expect(
      withInferredMcpEnv(
        null,
        [
          { key: "a", requiredEnv: ["TOKEN"] },
          { key: "b", requiredEnv: ["TOKEN"] },
        ],
        servers,
      ),
    ).toEqual([declaration("TOKEN")]);
  });

  test("required wins across inline and ref declarations, regardless of order", () => {
    for (const keys of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      const entries = {
        a: {
          type: "local" as const,
          command: ["mcp"],
          workerVars: [declaration("TOKEN", true)],
        },
        b: { type: "ref" as const, workerVars: [declaration("TOKEN")] },
      };
      const servers = Object.fromEntries(
        keys.map((key) => [key, entries[key as keyof typeof entries]]),
      );
      expect(withInferredMcpEnv(null, [], servers)).toEqual([
        declaration("TOKEN"),
      ]);
    }
  });

  test("agent environment wins but setup-only declarations cannot satisfy MCP vars", () => {
    const servers: OpenCodeMcpServers = {
      api: { type: "ref", workerVars: [declaration("TOKEN")] },
    };
    const environmentVar = {
      source: "value" as const,
      name: "TOKEN",
      value: "environment",
      secret: false,
      applies: "both" as const,
    };
    expect(withInferredMcpEnv([environmentVar], [], servers)).toEqual([
      environmentVar,
    ]);
    const setupVar = { ...environmentVar, applies: "setup" as const };
    const plan = planStepEnv({
      envVars: [setupVar],
      opencodeMcpJson: servers,
      inputJson: {},
      workerEnv: {},
    });
    expect(() => plan.resolveMcpEnv?.([])).toThrow('TOKEN (for MCP "api")');
  });

  test("missing environment, metadata and discovered variables aggregate before startup", () => {
    const plan = planStepEnv({
      envVars: [declaration("ENVIRONMENT_KEY")],
      opencodeMcpJson: {
        api: { type: "ref", workerVars: [declaration("DECLARED_KEY")] },
        inline: {
          type: "local",
          command: ["mcp"],
          workerVars: [declaration("INLINE_KEY")],
        },
      },
      inputJson: {},
      workerEnv: {},
    });
    try {
      plan.resolveMcpEnv?.([{ key: "api", requiredEnv: ["DISCOVERED_KEY"] }]);
      throw new Error("expected missing variables");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingStepEnvError);
      if (!(error instanceof MissingStepEnvError)) throw error;
      expect(error.missing).toEqual([
        "ENVIRONMENT_KEY",
        'DECLARED_KEY (for MCP "api")',
        'DISCOVERED_KEY (for MCP "api")',
        'INLINE_KEY (for MCP "inline")',
      ]);
    }
  });
});
