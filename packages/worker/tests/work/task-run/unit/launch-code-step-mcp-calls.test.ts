/**
 * A code step that declares MCP servers resolves them like an `mcp_tool`
 * launch (managed relay reached from the worker host) and exposes them as
 * `mcpCalls` for its MCP bridge; its devcontainer gets the host-gateway run
 * args. A code step without servers launches exactly as before. Compose
 * devcontainers fail for code steps with servers (ADR 0016, decision 9).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { ResolvedEnvironmentRef } from "@scarn/sdk/environment";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import { ConfigurationError } from "../../../../src/lib/errors";
import type { Grant } from "@scarn/sdk";
import { HOST_GATEWAY_RUN_ARGS } from "../../../../src/runtime/runtime-service/infra/devcontainer-mount-injection";
import { taskKindResolvesMcpServers } from "../../../../src/work/task-run/application/task-kind-runtime";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../../../../src/work/task-run/application/resolve-step-env";
import type { RegisterManagedLaunch } from "../../../../src/work/task-run/contracts/managed-launch-types";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  DEVCONTAINER_CONFIG_PATH,
  FAKE_DEVCONTAINER_ID,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const RELAY_URL = "http://localhost:3000/api/mcp-relay/launch-1";
const CAPABILITY = "synthetic-relay-capability-7b";
const BUN1_CONFIG_PATH = ".scarn/managed-devcontainers/bun1/devcontainer.json";
const BUN1: ResolvedEnvironmentRef = {
  kind: "inline",
  runtime: { kind: "managed", id: "bun1" },
};

describe("code step launch with MCP servers", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "code-mcp-launch-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "code-mcp-launch-provider-"),
    );
    await mkdir(path.join(workspacePath, ".opencode"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".opencode", "opencode.json"),
      JSON.stringify({
        mcp: {
          notion: { type: "remote", url: "https://mcp.notion.com/mcp" },
          db: { type: "local", command: ["pg-mcp"] },
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(providerOutputDir, { recursive: true, force: true });
  });

  function setup(input: {
    environment?: ResolvedEnvironmentRef;
    opencodeMcpJson: OpenCodeMcpServers | null;
    devcontainerJson?: Record<string, unknown>;
    grants?: Grant[];
    stepEnv?: Record<string, string>;
  }) {
    const stepEnv = input.stepEnv ?? { BASE: "base" };
    const log: CallLog = [];
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
    });
    if (input.devcontainerJson) {
      const devcontainerJson = input.devcontainerJson;
      const clone = deps.gitCloneService.cloneRepository.bind(
        deps.gitCloneService,
      );
      deps.gitCloneService.cloneRepository = async (cloneInput) => {
        const result = await clone(cloneInput);
        await writeFile(
          path.join(cloneInput.workspacePath, DEVCONTAINER_CONFIG_PATH),
          JSON.stringify(devcontainerJson),
        );
        return result;
      };
    }
    const registerManagedLaunch = vi.fn<RegisterManagedLaunch>(() =>
      Promise.resolve({
        notion: { relayUrl: RELAY_URL, capability: CAPABILITY },
      }),
    );
    const resolvedRefs: (readonly McpEnvRef[])[] = [];
    const resolveMcpEnv = (refs: readonly McpEnvRef[]): ResolvedStepEnv => {
      resolvedRefs.push(refs);
      return {
        stepEnv,
        setupEnv: {},
        promptEnv: { BASE: "base" },
        secretValues: [],
      };
    };
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      deps,
    );
    const launchInput = buildLaunchInput();
    const launch = () =>
      orchestrator.launch({
        ...launchInput,
        currentExecutionInfo: {
          ...launchInput.currentExecutionInfo,
          grants: input.grants ?? [],
        },
        ...(input.environment !== undefined
          ? { environment: input.environment }
          : {}),
        taskKind: "code",
        startAgent: false,
        opencodeMcpJson: input.opencodeMcpJson,
        stepEnv,
        resolveMcpEnv,
        registerManagedLaunch,
      });
    return { log, registerManagedLaunch, resolvedRefs, launch };
  }

  async function readConfig(configPath: string) {
    return JSON.parse(
      await readFile(path.join(workspacePath, configPath), "utf8"),
    ) as Record<string, unknown>;
  }

  test("a code task resolves MCP servers", () => {
    expect(taskKindResolvesMcpServers("code")).toBe(true);
  });

  test("resolves the servers through a host relay and exposes them as mcpCalls", async () => {
    const { log, registerManagedLaunch, launch } = setup({
      environment: BUN1,
      opencodeMcpJson: {
        notion: { type: "ref", auth: { connection: "notion" } },
      },
    });

    const env = await launch();

    expect(log).not.toContain("startOpencode");
    expect(env.agent).toBeNull();
    expect(env.mcpTool).toBeUndefined();
    expect(registerManagedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeKind: "host" }),
    );
    expect(env.mcpCalls).toEqual({
      servers: {
        notion: {
          type: "remote",
          url: RELAY_URL,
          headers: { Authorization: `Bearer ${CAPABILITY}` },
          oauth: false,
        },
      },
      env: { BASE: "base" },
      placement: {
        kind: "container",
        containerId: FAKE_DEVCONTAINER_ID,
        workspaceDir: env.workspaceFolder,
      },
    });
    expect(env.secretValues).toContain(CAPABILITY);
    const config = await readConfig(BUN1_CONFIG_PATH);
    expect(config["runArgs"]).toEqual([...HOST_GATEWAY_RUN_ARGS]);
    expect(config["containerEnv"] ?? {}).not.toHaveProperty(
      "SCARN_MCP_BRIDGE_URL",
    );
    await env.cleanup();
  });

  test("masks the encoded credential of a {basic:…} header", async () => {
    const { launch } = setup({
      environment: BUN1,
      opencodeMcpJson: {
        jira: {
          type: "remote",
          url: "https://mcp.atlassian.com/v1/mcp",
          headers: {
            Authorization: "Basic {basic:JIRA_EMAIL:JIRA_API_TOKEN}",
          },
        },
      },
      stepEnv: { JIRA_EMAIL: "bot@example.com", JIRA_API_TOKEN: "tok:ü" },
    });

    const env = await launch();

    expect(env.mcpCalls?.env).toMatchObject({ JIRA_API_TOKEN: "tok:ü" });
    expect(env.secretValues).toContain(
      Buffer.from("bot@example.com:tok:ü", "utf8").toString("base64"),
    );
    await env.cleanup();
  });

  test("a code step without servers launches no bridge and patches no run args", async () => {
    const { registerManagedLaunch, resolvedRefs, launch } = setup({
      environment: BUN1,
      opencodeMcpJson: null,
    });

    const env = await launch();

    expect(env.mcpCalls).toBeUndefined();
    expect(registerManagedLaunch).not.toHaveBeenCalled();
    expect(resolvedRefs.flat()).toEqual([]);
    const config = await readConfig(BUN1_CONFIG_PATH);
    expect(config["runArgs"]).toBeUndefined();
    await env.cleanup();
  });

  test("a code step with only a project work-item grant patches the run args for its step bridge but resolves no servers", async () => {
    const { registerManagedLaunch, resolvedRefs, launch } = setup({
      environment: BUN1,
      opencodeMcpJson: null,
      grants: [
        {
          resource: "workItem",
          action: "create",
          scope: "project",
          labels: [],
        },
      ],
    });

    const env = await launch();

    expect(env.mcpCalls).toBeUndefined();
    expect(registerManagedLaunch).not.toHaveBeenCalled();
    expect(resolvedRefs.flat()).toEqual([]);
    const config = await readConfig(BUN1_CONFIG_PATH);
    expect(config["runArgs"]).toEqual([...HOST_GATEWAY_RUN_ARGS]);
    await env.cleanup();
  });

  test("a compose devcontainer fails before the container starts", async () => {
    const { log, launch } = setup({
      opencodeMcpJson: { db: { type: "ref" } },
      devcontainerJson: {
        dockerComposeFile: "compose.yml",
        service: "app",
      },
    });

    const error = await rejectionOf(launch());

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain(
      "compose devcontainers aren't supported for code steps with `mcps` or work-item features yet",
    );
    expect(log).not.toContain("launchDevcontainer");
  });

  test("a compose devcontainer still launches a code step without servers", async () => {
    const { log, launch } = setup({
      opencodeMcpJson: {},
      devcontainerJson: {
        dockerComposeFile: "compose.yml",
        service: "app",
      },
    });

    const env = await launch();

    expect(log).toContain("launchDevcontainer");
    expect(env.mcpCalls).toBeUndefined();
    await env.cleanup();
  });
});
