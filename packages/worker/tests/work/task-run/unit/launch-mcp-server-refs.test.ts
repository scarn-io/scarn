/**
 * MCP server refs on both launch paths: the workspace orchestrator resolves
 * them against the cloned repo before the devcontainer starts, and the
 * host runtime resolves them before it builds the OpenCode
 * context. A missing ref fails the launch before any runtime is started, and
 * every repo server the step does not name reaches the overlay disabled. A
 * host launch whose inline server is missing a tagged variable fails before
 * OpenCode starts.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import {
  MissingStepEnvError,
  planStepEnv,
} from "../../../../src/work/task-run/application/resolve-step-env";
import {
  HostOpencodeBootstrap,
  type HostStartInput,
  type HostStartResult,
} from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import { McpServerRefNotFoundError } from "../../../../src/work/task-run/infra/mcp-server-ref-resolver";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const REF_NAME = "scarn-test-ref-db-7f3a";

async function rejectionOf(promise: Promise<object>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

describe("workspace launch resolves MCP server refs", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "mcp-ref-launch-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "mcp-ref-launch-provider-"),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function buildOrchestrator(log: CallLog) {
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
    });
    return {
      deps,
      orchestrator: new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
        undefined,
        deps,
      ),
    };
  }

  test("a ref defined in the project config reaches the OpenCode overlay as a full definition", async () => {
    const log: CallLog = [];
    const { deps, orchestrator } = buildOrchestrator(log);
    await mkdir(path.join(workspacePath, ".opencode"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".opencode", "opencode.json"),
      JSON.stringify({
        mcp: {
          [REF_NAME]: { type: "local", command: ["pg-mcp"], enabled: true },
        },
      }),
    );
    await writeFile(
      path.join(workspacePath, ".mcp.json"),
      JSON.stringify({
        mcpServers: { unused: { command: "npx", args: ["unused-mcp"] } },
      }),
    );

    await orchestrator.launch({
      ...buildLaunchInput(),
      opencodeMcpJson: { db: { type: "ref", name: REF_NAME, codemode: true } },
    });

    const content =
      deps.opencodeBootstrap.startInputs[0]?.opencodeConfigContent;
    const config = JSON.parse(content ?? "{}") as {
      mcp?: { servers?: Record<string, unknown> };
    };
    expect(config.mcp?.servers).toEqual({
      db: { type: "local", command: ["pg-mcp"], codemode: true },
      [REF_NAME]: {
        type: "local",
        command: ["pg-mcp"],
        disabled: true,
        codemode: false,
      },
      unused: {
        type: "local",
        command: ["npx", "unused-mcp"],
        disabled: true,
        codemode: false,
      },
    });
  });

  test("a missing ref fails before the payload is provisioned or the devcontainer starts", async () => {
    const log: CallLog = [];
    const { deps, orchestrator } = buildOrchestrator(log);

    const error = await rejectionOf(
      orchestrator.launch({
        ...buildLaunchInput(),
        opencodeMcpJson: { db: { type: "ref", name: REF_NAME } },
      }),
    );

    expect(error).toBeInstanceOf(McpServerRefNotFoundError);
    expect(error.message).toContain(".opencode/opencode.json (not present)");
    expect(log).not.toContain("ensurePayload");
    expect(log).not.toContain("launchDevcontainer");
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
  });
});

describe("workspace launch infers MCP ref env (D3)", () => {
  const MISSING_VAR = "MCP_LAUNCH_TEST_UNSET_TOKEN_7F3A";
  const SET_VAR = "MCP_LAUNCH_TEST_SET_TOKEN_7F3A";
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "mcp-env-launch-ws-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "mcp-env-launch-provider-"),
    );
    await mkdir(path.join(workspacePath, ".opencode"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".opencode", "opencode.json"),
      JSON.stringify({
        mcp: {
          [REF_NAME]: {
            type: "local",
            command: ["pg-mcp"],
            environment: { TOKEN: `{env:${MISSING_VAR}}` },
          },
          tracing: {
            type: "local",
            command: ["trace-mcp"],
            environment: { TOKEN: `{env:${SET_VAR}}` },
          },
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  async function launch(
    opencodeMcpJson: OpenCodeMcpServers,
    log: CallLog = [],
  ) {
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
    });
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      deps,
    );
    const { resolved, resolveMcpEnv } = planStepEnv({
      envVars: null,
      inputJson: {},
      workerEnv: { [SET_VAR]: "set-token-value-123" },
      opencodeMcpJson,
    });
    const environment = await orchestrator.launch({
      ...buildLaunchInput(),
      opencodeMcpJson,
      stepEnv: resolved.stepEnv,
      resolveMcpEnv,
    });
    return { deps, environment };
  }

  test("a ref missing a variable fails before the devcontainer starts", async () => {
    const log: CallLog = [];
    const error = await rejectionOf(
      launch({ db: { type: "ref", name: REF_NAME } }, log),
    );

    expect(error).toBeInstanceOf(MissingStepEnvError);
    expect(error.message).toContain(`${MISSING_VAR} (for MCP "db")`);
    expect(log).not.toContain("launchDevcontainer");
  });

  test("an inferred variable that is set reaches the agent's env", async () => {
    const { deps, environment } = await launch({
      tracing: { type: "ref" },
    });

    expect(deps.opencodeBootstrap.startInputs[0]?.stepEnv).toEqual({
      [SET_VAR]: "set-token-value-123",
    });
    expect(environment.secretValues).toContain("set-token-value-123");
  });
});

class FakeHostOpencodeBootstrap extends HostOpencodeBootstrap {
  startInputs: HostStartInput[] = [];
  override start(input: HostStartInput): Promise<HostStartResult> {
    this.startInputs.push(input);
    const agentLogDirectory = path.join(input.sessionAgentHomeDir, ".log");
    return Promise.resolve({
      agentBaseUrl: "http://127.0.0.1:54999",
      serverPassword: "fake-server-password",
      agentLogDirectory,
      agentLogPath: path.join(agentLogDirectory, "opencode-serve.log"),
      pid: 424242,
    });
  }
  override stop(): void {}
}

describe("host launch with an inline server missing a variable (S3)", () => {
  const MISSING_VAR = "MCP_HOST_LAUNCH_TEST_UNSET_TOKEN_7F3A";
  let providerOutputDir: string;

  beforeEach(async () => {
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "mcp-host-launch-provider-"),
    );
  });

  afterEach(async () => {
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  test("fails with MissingStepEnvError naming the MCP before OpenCode starts", async () => {
    const log: CallLog = [];
    const workspaceDeps = buildOrchestratorFakeDeps({
      workspacePath: providerOutputDir,
      providerOutputDir,
      log,
    });
    const hostOpencodeBootstrap = new FakeHostOpencodeBootstrap();
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {
        ...workspaceDeps,
        hostOpencodeBootstrap,
      },
    );
    const opencodeMcpJson: OpenCodeMcpServers = {
      playwright: {
        type: "local",
        command: ["npx", "@playwright/mcp"],
        environment: { TOKEN: `{env:${MISSING_VAR}}` },
      },
    };
    const sessionId = createUuidV7();

    const envVars = [
      {
        name: MISSING_VAR,
        source: "inherit",
        from: MISSING_VAR,
        secret: true,
        optional: false,
        mcp: "playwright",
        applies: "agent",
      },
    ] as const;
    const launchStep = async () => {
      return await orchestrator.launch({
        ...buildLaunchInput(),
        environment: {
          kind: "inline",
          runtime: { kind: "host" },
          envJson: [...envVars],
        },
        startAgent: true,
        sessionId,
        projectId: createUuidV7(),
        requestedByUserId: createUuidV7(),
        repo: {
          mode: "readOnly",
          gitCredentials: "none",
          baseBranch: null,
        },
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
        currentExecutionInfo: {
          taskRunId: sessionId,
          resultSchemaJson: null,
          turnsRemaining: null,
        },
      });
    };

    const error = await rejectionOf(launchStep());

    expect(error).toBeInstanceOf(MissingStepEnvError);
    expect(error.message).toContain(`${MISSING_VAR} (for MCP "playwright")`);
    expect(hostOpencodeBootstrap.startInputs).toEqual([]);
    expect(log).toContain("clone");
  });
});

describe("host launch resolves MCP server refs", () => {
  test("a missing ref fails before OpenCode starts and cleans up the checkout", async () => {
    const sessionId = createUuidV7();
    const workspacePath = await mkdtemp(
      path.join(os.tmpdir(), "host-missing-ref-"),
    );
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir: workspacePath,
      log: [],
    });
    const hostOpencodeBootstrap = new FakeHostOpencodeBootstrap();
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      { ...deps, hostOpencodeBootstrap },
    );
    try {
      const error = await rejectionOf(
        orchestrator.launch({
          ...buildLaunchInput(),
          environment: { kind: "inline", runtime: { kind: "host" } },
          sessionId,
          repo: {
            mode: "readOnly",
            gitCredentials: "none",
            baseBranch: null,
          },
          opencodeMcpJson: { db: { type: "ref", name: REF_NAME } },
        }),
      );
      expect(error).toBeInstanceOf(McpServerRefNotFoundError);
      expect(error.message).toContain(".opencode/opencode.json (not present)");
      expect(error.message).not.toContain("global");
      expect(hostOpencodeBootstrap.startInputs).toEqual([]);
      expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
