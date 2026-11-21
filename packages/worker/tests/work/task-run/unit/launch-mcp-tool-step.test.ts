/**
 * An `mcp_tool` launch resolves the step's MCP servers exactly as an agent
 * launch does (refs, managed relay, inferred env) but starts no OpenCode,
 * provisions no payload or provider access, and installs no pipeline
 * builder. The launch result carries the resolved servers, env and placement
 * for the tool call.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { ResolvedEnvironmentRef } from "@scarn/sdk/environment";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../../../../src/work/task-run/application/resolve-step-env";
import type { RegisterManagedLaunch } from "../../../../src/work/task-run/contracts/managed-launch-types";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import { McpServerRefNotFoundError } from "../../../../src/work/task-run/infra/mcp-server-ref-resolver";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  FAKE_DEVCONTAINER_ID,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const RELAY_URL = "http://localhost:3000/api/mcp-relay/launch-1";
const CAPABILITY = "synthetic-relay-capability-7b";
const BUN1_CONFIG_PATH = ".scarn/managed-devcontainers/bun1/devcontainer.json";

describe("mcp_tool launch", () => {
  let workspacePath: string;
  let providerOutputDir: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "mcp-tool-launch-"));
    providerOutputDir = await mkdtemp(
      path.join(os.tmpdir(), "mcp-tool-launch-provider-"),
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
    opencodeMcpJson: OpenCodeMcpServers;
  }) {
    const log: CallLog = [];
    const deps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
    });
    const hostStart = vi.spyOn(deps.hostOpencodeBootstrap, "start");
    const registerManagedLaunch = vi.fn<RegisterManagedLaunch>(() =>
      Promise.resolve({
        notion: { relayUrl: RELAY_URL, capability: CAPABILITY },
      }),
    );
    const resolvedRefs: (readonly McpEnvRef[])[] = [];
    const resolveMcpEnv = (refs: readonly McpEnvRef[]): ResolvedStepEnv => {
      resolvedRefs.push(refs);
      return {
        stepEnv: { BASE: "base", DB_URL: "postgres://db" },
        setupEnv: {},
        promptEnv: { BASE: "base" },
        secretValues: ["postgres://db"],
      };
    };
    const secretBatches: (readonly string[])[] = [];
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      deps,
    );
    const launch = () =>
      orchestrator.launch({
        ...buildLaunchInput(),
        ...(input.environment !== undefined
          ? { environment: input.environment }
          : {}),
        taskKind: "mcp_tool",
        startAgent: false,
        opencodeMcpJson: input.opencodeMcpJson,
        stepEnv: { BASE: "base" },
        resolveMcpEnv,
        registerManagedLaunch,
        onSecretValues: (values) => {
          log.push("onSecretValues");
          secretBatches.push(values);
        },
      });
    return {
      log,
      deps,
      hostStart,
      registerManagedLaunch,
      resolvedRefs,
      secretBatches,
      launch,
    };
  }

  test("a container launch resolves the servers without starting OpenCode", async () => {
    const { log, deps, registerManagedLaunch, resolvedRefs, launch } = setup({
      opencodeMcpJson: {
        notion: { type: "ref", auth: { connection: "notion" } },
      },
    });

    const env = await launch();

    expect(log).not.toContain("ensurePayload");
    expect(log).not.toContain("planMounts");
    expect(log).not.toContain("patchMounts");
    expect(log).not.toContain("prepareAgentHome");
    expect(log).not.toContain("startOpencode");
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
    expect(env.agent).toBeNull();
    expect(env.aiImage).toBe("");
    expect(registerManagedLaunch).toHaveBeenCalledTimes(1);
    expect(registerManagedLaunch).toHaveBeenCalledWith({
      runtimeKind: "host",
      entries: { notion: { url: "https://mcp.notion.com/mcp" } },
      remotesWithoutAuth: {},
    });
    expect(resolvedRefs).toHaveLength(1);
    expect(env.mcpTool).toEqual({
      servers: {
        notion: {
          type: "remote",
          url: RELAY_URL,
          headers: { Authorization: `Bearer ${CAPABILITY}` },
          oauth: false,
        },
      },
      env: { BASE: "base", DB_URL: "postgres://db" },
      placement: {
        kind: "container",
        containerId: FAKE_DEVCONTAINER_ID,
        workspaceDir: env.workspaceFolder,
      },
    });
    expect(env.workspaceFolder).toBe(
      `/workspaces/${path.basename(workspacePath)}`,
    );
    await env.cleanup();
  });

  test("registers the relay capability and the inferred secrets for masking before the container starts", async () => {
    const { log, secretBatches, launch } = setup({
      opencodeMcpJson: {
        notion: { type: "ref", auth: { connection: "notion" } },
      },
    });
    const env = await launch();

    expect(log.indexOf("onSecretValues")).toBeGreaterThan(-1);
    expect(log.indexOf("onSecretValues")).toBeLessThan(
      log.indexOf("launchDevcontainer"),
    );
    expect([...env.secretValues].sort()).toEqual(
      [CAPABILITY, "postgres://db"].sort(),
    );
    expect(secretBatches).toContainEqual(env.secretValues);
    await env.cleanup();
  });

  test("a missing ref fails before the container starts", async () => {
    const { log, launch } = setup({
      opencodeMcpJson: { missing: { type: "ref" } },
    });

    const error = await rejectionOf(launch());

    expect(error).toBeInstanceOf(McpServerRefNotFoundError);
    expect(log).not.toContain("launchDevcontainer");
  });

  test("a step with no MCP server of its own fails before the container starts", async () => {
    const { log, launch } = setup({ opencodeMcpJson: {} });

    const error = await rejectionOf(launch());

    expect((error as Error).message).toBe(
      "The MCP tool step has no MCP server to call.",
    );
    expect(log).not.toContain("launchDevcontainer");
  });

  test("a host launch places the server on the checkout and starts nothing", async () => {
    const { hostStart, registerManagedLaunch, launch } = setup({
      environment: { kind: "inline", runtime: { kind: "host" } },
      opencodeMcpJson: { db: { type: "ref" } },
    });

    const env = await launch();

    expect(hostStart).not.toHaveBeenCalled();
    expect(registerManagedLaunch).not.toHaveBeenCalled();
    expect(env.runtimeContainerId).toBeNull();
    expect(env.agent).toBeNull();
    expect(env.mcpTool).toEqual({
      servers: { db: { type: "local", command: ["pg-mcp"] } },
      env: { BASE: "base", DB_URL: "postgres://db" },
      placement: { kind: "host", workspaceDir: workspacePath },
    });
    await env.cleanup();
  });

  test("a managed runtime doesn't install the pipeline builder", async () => {
    const { launch } = setup({
      environment: {
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
      },
      opencodeMcpJson: { db: { type: "ref" } },
    });

    const env = await launch();
    const config = JSON.parse(
      await readFile(path.join(workspacePath, BUN1_CONFIG_PATH), "utf8"),
    ) as Record<string, unknown>;

    expect(env.devcontainerConfigPath).toBe(BUN1_CONFIG_PATH);
    expect(config["onCreateCommand"]).toBeUndefined();
    expect(env.mcpTool?.placement.kind).toBe("container");
    await env.cleanup();
  });
});
