import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import { planStepEnv } from "../../../../src/work/task-run/application/resolve-step-env";
import {
  environmentLaunchFixture,
  namedEnvironment,
} from "./helpers/environment-launch-fixture";
import { rejectionOf } from "./helpers/orchestrator-launch-fakes";

const workerVar = (name: string, optional = false) => ({
  name,
  source: "inherit" as const,
  from: name,
  secret: true,
  optional,
  applies: "agent" as const,
});

describe("named environment + MCP variables at launch", () => {
  let workspacePath: string;
  const { setup } = environmentLaunchFixture((value) => {
    workspacePath = value;
  });

  for (const type of ["local", "remote", "ref"] as const) {
    test(`${type} declarations combine with a named environment before runtime startup`, async () => {
      if (type === "ref") {
        await mkdir(path.join(workspacePath, ".opencode"), { recursive: true });
        await writeFile(
          path.join(workspacePath, ".opencode/opencode.json"),
          JSON.stringify({
            mcp: {
              api: {
                type: "remote",
                url: "https://example.com",
                headers: {
                  Authorization: "Bearer {env:TOKEN}",
                  Site: "{env:SITE}",
                  Region: "{env:REGION}",
                },
              },
            },
          }),
        );
      }
      const { orchestrator, input, deps } = setup();
      const opencodeMcpJson: OpenCodeMcpServers = {
        api: {
          ...(type === "local"
            ? { type, command: ["mcp"], environment: { TOKEN: "{env:TOKEN}" } }
            : type === "remote"
              ? {
                  type,
                  url: "https://example.com",
                  headers: { Authorization: "Bearer {env:TOKEN}" },
                }
              : { type }),
          workerVars: [workerVar("TOKEN"), workerVar("SITE", true)],
        },
      };
      const secrets: string[] = [];
      const lines: string[] = [];
      const launch = deps.devcontainerLauncher.launch.bind(
        deps.devcontainerLauncher,
      );
      deps.devcontainerLauncher.launch = (launchInput) => {
        expect(secrets).toContain("mcp-private-token");
        if (type === "ref")
          expect(secrets).toContain("inferred-private-region");
        expect(launchInput.hostEnv?.["TOKEN"]).toBeUndefined();
        expect(
          lines.filter((line) => line.startsWith("Environment resolved:")),
        ).toHaveLength(1);
        return launch(launchInput);
      };
      const launched = await orchestrator.launch({
        ...input,
        startAgent: true,
        environment: namedEnvironment({
          runtime: { kind: "managed", id: "bun1" },
          vars: [
            {
              name: "TITLE",
              source: "value",
              value: "named title",
              secret: false,
            },
          ],
        }),
        opencodeMcpJson,
        onSecretValues: (values) => secrets.push(...values),
        logger: {
          log: (_scope, message) => lines.push(message),
          debug: () => {},
          error: () => {},
        },
        resolveEnvironmentEnv: (environment) =>
          Promise.resolve(
            planStepEnv({
              envVars: environment.envVars,
              inputJson: {},
              workerEnv: {
                TOKEN: "mcp-private-token",
                REGION: "inferred-private-region",
              },
              opencodeMcpJson,
            }),
          ),
      });
      expect(deps.opencodeBootstrap.startInputs[0]?.stepEnv).toMatchObject({
        TITLE: "named title",
        TOKEN: "mcp-private-token",
      });
      expect(launched.environmentDiagnostics?.vars).toEqual([
        { name: "TITLE", source: "value" },
        { name: "TOKEN", source: "worker" },
        { name: "SITE", source: "worker" },
        ...(type === "ref"
          ? [{ name: "REGION", source: "worker" as const }]
          : []),
      ]);
      const content =
        deps.opencodeBootstrap.startInputs[0]?.opencodeConfigContent;
      expect(content).toBeDefined();
      expect(content).not.toContain("workerVars");
      expect(content).not.toContain("mcp-private-token");
      expect(lines.join("\n")).not.toContain("mcp-private-token");
      expect(lines.join("\n")).not.toContain("inferred-private-region");
      expect(JSON.stringify(launched.environmentDiagnostics)).not.toContain(
        "named title",
      );
    });
  }

  test("missing named and MCP vars aggregate and prevent startup", async () => {
    const { orchestrator, input, deps } = setup();
    const opencodeMcpJson: OpenCodeMcpServers = {
      api: {
        type: "remote",
        url: "https://example.com",
        workerVars: [workerVar("TOKEN")],
      },
    };
    const error = await rejectionOf(
      orchestrator.launch({
        ...input,
        startAgent: true,
        environment: namedEnvironment({
          runtime: { kind: "managed", id: "bun1" },
          vars: [workerVar("NAMED")],
        }),
        opencodeMcpJson,
        resolveEnvironmentEnv: (environment) =>
          Promise.resolve(
            planStepEnv({
              envVars: environment.envVars,
              inputJson: {},
              workerEnv: {},
              opencodeMcpJson,
            }),
          ),
      }),
    );
    if (!(error instanceof Error)) throw error;
    expect(error.message).toContain("NAMED");
    expect(error.message).toContain('TOKEN (for MCP "api")');
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
  });
});
