import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import { planStepEnv } from "../../../../src/work/task-run/application/resolve-step-env";
import type { LaunchedRuntimeOrchestrator } from "../../../../src/work/task-run/contracts/process-project-work-types";
import {
  createRoutingDeps,
  createWorkerClient,
  createWorkerContext,
  runClaim,
} from "./helpers/claimed-task-fixtures";
import { environmentLaunchFixture } from "./helpers/environment-launch-fixture";

const token = (secret: boolean) => ({
  name: "TOKEN",
  source: "inherit" as const,
  from: "TOKEN",
  secret,
  optional: false,
  applies: "agent" as const,
});

const publicServer = {
  type: "remote" as const,
  url: "https://public.example.com",
  workerVars: [token(false)],
};
const secretServer = {
  type: "remote" as const,
  url: "https://private.example.com",
  workerVars: [token(true)],
};

describe("claimed-run MCP secrecy", () => {
  let workspacePath: string;
  const { setup } = environmentLaunchFixture((value) => {
    workspacePath = value;
  });

  const cases: { name: string; servers: OpenCodeMcpServers }[] = [
    {
      name: "public then secret",
      servers: { a: publicServer, b: secretServer },
    },
    {
      name: "secret then public",
      servers: { a: secretServer, b: publicServer },
    },
    {
      name: "public then inferred secret",
      servers: { a: publicServer, b: { type: "ref" } },
    },
  ];

  for (const { name, servers } of cases) {
    test(`${name}: final resolution excludes the secret from prompt variables`, () => {
      const plan = planStepEnv({
        envVars: [],
        inputJson: {},
        workerEnv: { TOKEN: "synthetic-private-token" },
        opencodeMcpJson: servers,
      });
      const resolved =
        plan.resolveMcpEnv?.([{ key: "b", requiredEnv: ["TOKEN"] }]) ??
        plan.resolved;
      expect(resolved.promptEnv).toEqual({});
      expect(resolved.secretValues).toContain("synthetic-private-token");
    });

    for (const hasEnvironmentVars of [false, true]) {
      test(`${name}: claimed-run prompt is secret-free (environment vars: ${String(hasEnvironmentVars)})`, async () => {
        await mkdir(path.join(workspacePath, ".opencode"), { recursive: true });
        await writeFile(
          path.join(workspacePath, ".opencode/opencode.json"),
          JSON.stringify({
            mcp: {
              b: {
                type: "remote",
                url: "https://private.example.com",
                headers: { Authorization: "{env:TOKEN}" },
              },
            },
          }),
        );
        const { orchestrator, deps: launchDeps } = setup();
        const secretValues: string[] = [];
        const workerClient = createWorkerClient();
        workerClient.getTaskRunWorkerContext = vi.fn(() =>
          Promise.resolve(
            createWorkerContext(
              {
                kind: "inline",
                runtime: { kind: "managed", id: "bun1" },
                envJson: hasEnvironmentVars
                  ? [
                      {
                        name: "TITLE",
                        source: "value",
                        value: "safe-title",
                        secret: false,
                        applies: "agent",
                      },
                    ]
                  : [],
              },
              null,
              {
                prompt: "Token=[{{env.TOKEN}}]",
                opencodeMcpJson: servers,
              },
            ),
          ),
        );
        const deps = createRoutingDeps({
          workerClient,
          workspaceOrchestrator: {
            launch: vi.fn<LaunchedRuntimeOrchestrator["launch"]>((input) =>
              orchestrator.launch({
                ...input,
                onSecretValues: (values) => {
                  secretValues.push(...values);
                  input.onSecretValues?.(values);
                },
              }),
            ),
          },
        });
        const promptAsync = vi.fn(() =>
          Promise.resolve({
            sessionId: "agent-session",
          }),
        );
        deps.agentRunner.promptAsync = promptAsync;
        await runClaim(deps, {
          localEnvVars: { TOKEN: "synthetic-private-token" },
        });
        expect(promptAsync).toHaveBeenCalledWith(
          expect.objectContaining({ promptText: "Header\nToken=[]\nFooter" }),
        );
        expect(
          launchDeps.opencodeBootstrap.startInputs[0]?.stepEnv,
        ).toMatchObject({ TOKEN: "synthetic-private-token" });
        expect(secretValues).toContain("synthetic-private-token");
      });
    }
  }

  test("explicit agent ENV secrecy still takes precedence over MCP secrecy", () => {
    const plan = planStepEnv({
      envVars: [token(false)],
      inputJson: {},
      workerEnv: { TOKEN: "intentionally-public" },
      opencodeMcpJson: { a: secretServer, b: { type: "ref" } },
    });
    const resolved = plan.resolveMcpEnv?.([
      { key: "b", requiredEnv: ["TOKEN"] },
    ]);
    expect(resolved?.promptEnv).toEqual({ TOKEN: "intentionally-public" });
    expect(resolved?.secretValues).toEqual([]);
  });

  test("a server's explicit public declaration still suppresses its own ref inference", () => {
    const plan = planStepEnv({
      envVars: [],
      inputJson: {},
      workerEnv: { TOKEN: "intentionally-public" },
      opencodeMcpJson: { a: { type: "ref", workerVars: [token(false)] } },
    });
    const resolved = plan.resolveMcpEnv?.([
      { key: "a", requiredEnv: ["TOKEN"] },
    ]);
    expect(resolved?.promptEnv).toEqual({ TOKEN: "intentionally-public" });
    expect(resolved?.secretValues).toEqual([]);
  });
});
