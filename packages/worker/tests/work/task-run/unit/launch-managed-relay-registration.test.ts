/**
 * `launchRuntimeEnvironment` registers the run's managed launch with its claim
 * token, reports the registration so the caller can arm the control-loss
 * watchdog, and rewrites a loopback relay URL to the Docker host-gateway alias
 * for runtimes that aren't the host.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import {
  HostOpencodeBootstrap,
  type HostStartInput,
  type HostStartResult,
} from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { resolveSessionAgentHomeDir } from "../../../../src/runtime/runtime-service/infra/opencode-agent-home";
import { launchRuntimeEnvironment } from "../../../../src/work/task-run/application/process-claimed-task-run-launch";
import type { ManagedLaunchEntries } from "../../../../src/work/task-run/contracts/managed-launch-types";
import type {
  LaunchedRuntimeOrchestrator,
  TaskRunWorkerClient,
} from "../../../../src/work/task-run/contracts/process-project-work-types";
import { noopReporter } from "../../../../src/work/task-run/contracts/work-reporter";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createWorkerClient,
  createWorkerContext,
  hostEnvironment,
  requestedByUserId,
  taskRunId,
} from "./helpers/claimed-task-fixtures";
import { buildOrchestratorFakeDeps } from "./helpers/orchestrator-launch-fakes";

const LOCAL_RELAY_URL = "http://localhost:3000/api/mcp-relay/launch-1";
const CAPABILITY = "synthetic-relay-capability-41d7";

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

function registeringClient(): TaskRunWorkerClient & {
  registerTaskRunManagedLaunch: ReturnType<
    typeof vi.fn<
      NonNullable<TaskRunWorkerClient["registerTaskRunManagedLaunch"]>
    >
  >;
} {
  return {
    ...createWorkerClient(hostEnvironment),
    registerTaskRunManagedLaunch: vi.fn(({ entries }) =>
      Promise.resolve<ManagedLaunchEntries>(
        Object.fromEntries(
          Object.keys(entries).map((key) => [
            key,
            { relayUrl: LOCAL_RELAY_URL, capability: CAPABILITY },
          ]),
        ),
      ),
    ),
  };
}

let workspacePath: string;
let providerOutputDir: string;
const sessionHomes: string[] = [];

beforeEach(async () => {
  workspacePath = await mkdtemp(path.join(os.tmpdir(), "managed-launch-"));
  providerOutputDir = await mkdtemp(
    path.join(os.tmpdir(), "managed-launch-provider-"),
  );
});

afterEach(async () => {
  await Promise.all(
    [workspacePath, providerOutputDir, ...sessionHomes.splice(0)].map(
      (directory) => rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("managed launch registration", () => {
  async function hostLaunch(opencodeMcpJson: OpenCodeMcpServers) {
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
    const hostOpencodeBootstrap = new FakeHostOpencodeBootstrap();
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      {
        ...buildOrchestratorFakeDeps({
          workspacePath,
          providerOutputDir,
          log: [],
        }),
        hostOpencodeBootstrap,
      },
    );
    const workerClient = registeringClient();
    const routingDeps = createRoutingDeps({
      workerClient,
      workspaceOrchestrator: createRecordingOrchestrator(workspacePath),
    });
    routingDeps.runtimeEnvironmentOrchestrator = orchestrator;
    const onManagedLaunchRegistered = vi.fn();
    const localRuntimeSessionId = createUuidV7();
    sessionHomes.push(resolveSessionAgentHomeDir(localRuntimeSessionId));
    const env = await launchRuntimeEnvironment(routingDeps, {
      startAgent: true,
      claimToken: "claim-token",
      onManagedLaunchRegistered,
      localRuntimeSessionId,
      requestedByUserId,
      workerContext: createWorkerContext(hostEnvironment, null, {
        opencodeMcpJson,
      }),
      reporter: noopReporter,
      taskRunId,
    });
    await env.cleanup();
    return { workerClient, onManagedLaunchRegistered, hostOpencodeBootstrap };
  }

  test("registers with the claim token, arms the watchdog once and keeps the host relay URL", async () => {
    const { workerClient, onManagedLaunchRegistered, hostOpencodeBootstrap } =
      await hostLaunch({
        notion: { type: "ref", auth: { connection: "notion" } },
      });

    expect(workerClient.registerTaskRunManagedLaunch).toHaveBeenCalledWith({
      taskRunId,
      claimToken: "claim-token",
      entries: { notion: { url: "https://mcp.notion.com/mcp" } },
      remotesWithoutAuth: {},
    });
    expect(onManagedLaunchRegistered).toHaveBeenCalledTimes(1);
    const content = hostOpencodeBootstrap.startInputs[0]?.opencodeConfigContent;
    expect(content).toContain(LOCAL_RELAY_URL);
  });

  test("sends each server's resolved URL: the ref's from the repository, and a remote's without auth", async () => {
    const { workerClient } = await hostLaunch({
      docs: { type: "ref", name: "notion", auth: { connection: "notion" } },
      inline: {
        type: "remote",
        url: "https://mcp.notion.com/mcp/",
        auth: { connection: "notion" },
      },
      plain: { type: "remote", url: "https://example.test/mcp" },
      off: { type: "remote", url: "https://off.test/mcp", disabled: true },
    });

    expect(workerClient.registerTaskRunManagedLaunch).toHaveBeenCalledWith({
      taskRunId,
      claimToken: "claim-token",
      entries: {
        docs: { url: "https://mcp.notion.com/mcp" },
        inline: { url: "https://mcp.notion.com/mcp/" },
      },
      remotesWithoutAuth: { plain: { url: "https://example.test/mcp" } },
    });
  });

  test("a step without connection auth neither registers nor arms the watchdog", async () => {
    const { workerClient, onManagedLaunchRegistered, hostOpencodeBootstrap } =
      await hostLaunch({ db: { type: "ref" } });

    expect(workerClient.registerTaskRunManagedLaunch).not.toHaveBeenCalled();
    expect(onManagedLaunchRegistered).not.toHaveBeenCalled();
    expect(hostOpencodeBootstrap.startInputs).toHaveLength(1);
  });

  test.each([
    ["devcontainer", "http://host.docker.internal:3000/api/mcp-relay/launch-1"],
    ["managed", "http://host.docker.internal:3000/api/mcp-relay/launch-1"],
    ["host", LOCAL_RELAY_URL],
  ] as const)(
    "a %s runtime reaches the relay at %s",
    async (runtimeKind, relayUrl) => {
      const workerClient = registeringClient();
      const registered: ManagedLaunchEntries[] = [];
      const launch = vi.fn<LaunchedRuntimeOrchestrator["launch"]>(
        async (input) => {
          const entries = await input.registerManagedLaunch?.({
            runtimeKind,
            entries: { notion: { url: "https://mcp.notion.com/mcp" } },
            remotesWithoutAuth: {},
          });
          if (entries) registered.push(entries);
          return await createRecordingOrchestrator(workspacePath).launch(input);
        },
      );
      const routingDeps = createRoutingDeps({
        workerClient,
        workspaceOrchestrator: { launch },
      });
      const onManagedLaunchRegistered = vi.fn();

      await launchRuntimeEnvironment(routingDeps, {
        startAgent: true,
        claimToken: "claim-token",
        onManagedLaunchRegistered,
        localRuntimeSessionId: createUuidV7(),
        requestedByUserId,
        workerContext: createWorkerContext(),
        reporter: noopReporter,
        taskRunId,
      });

      expect(registered).toEqual([
        { notion: { relayUrl, capability: CAPABILITY } },
      ]);
      expect(onManagedLaunchRegistered).toHaveBeenCalledTimes(1);
    },
  );
});
