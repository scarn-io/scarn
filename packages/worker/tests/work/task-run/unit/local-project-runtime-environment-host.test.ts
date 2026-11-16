import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { resolveRepoConfig } from "@scarn/sdk/repo-config";
import { resolveSessionAgentHomeDir } from "../../../../src/runtime/runtime-service/infra/opencode-agent-home";
import {
  HostOpencodeBootstrap,
  type HostStartInput,
  type HostStartResult,
} from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import { launchRuntimeEnvironment } from "../../../../src/work/task-run/application/process-claimed-task-run-launch";
import { noopReporter } from "../../../../src/work/task-run/contracts/work-reporter";
import {
  createRecordingOrchestrator,
  createRoutingDeps,
  createWorkerClient,
  createWorkerContext,
} from "./helpers/claimed-task-fixtures";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  FAKE_CREDENTIAL,
  FAKE_PAYLOAD_VERSION,
  FAKE_SERVER_PASSWORD,
  FakeGitCommitPushService,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

class FakeHostOpencodeBootstrap extends HostOpencodeBootstrap {
  startInputs: HostStartInput[] = [];
  stopCalls: (number | null | undefined)[] = [];
  shouldFail = false;
  override start(input: HostStartInput): Promise<HostStartResult> {
    this.startInputs.push(input);
    const agentLogDirectory = path.join(
      input.sessionAgentHomeDir,
      ".scarn-log",
    );
    const agentLogPath = path.join(agentLogDirectory, "opencode-serve.log");
    input.onLogReady?.({ agentLogDirectory, agentLogPath });
    if (this.shouldFail) {
      return Promise.reject(new Error("host boot failed"));
    }
    return Promise.resolve({
      agentBaseUrl: "http://127.0.0.1:54321",
      serverPassword: "fake-server-password",
      agentLogDirectory,
      agentLogPath,
      pid: 12345,
    });
  }
  override stop(pid: number | null | undefined): void {
    this.stopCalls.push(pid);
  }
}

describe("host checkout lifecycle", () => {
  let workspacePath: string;
  let providerOutputDir: string;
  const homes: string[] = [];

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), "host-checkout-"));
    providerOutputDir = await mkdtemp(path.join(os.tmpdir(), "host-provider-"));
  });

  afterEach(async () => {
    await Promise.all(
      [workspacePath, providerOutputDir, ...homes.splice(0)].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  function setup() {
    const log: CallLog = [];
    const commitPush = new FakeGitCommitPushService(log);
    const baseDeps = buildOrchestratorFakeDeps({
      workspacePath,
      providerOutputDir,
      log,
      gitCommitPushService: commitPush,
    });
    const deps = {
      ...baseDeps,
      hostOpencodeBootstrap: new FakeHostOpencodeBootstrap(),
    };
    const input = buildLaunchInput();
    input.environment = { kind: "inline", runtime: { kind: "host" } };
    homes.push(resolveSessionAgentHomeDir(input.sessionId));
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      deps,
    );
    return { log, deps, input, orchestrator, commitPush };
  }

  test("starts the host payload with provider config and credentials and returns host metadata", async () => {
    const { deps, input, orchestrator } = setup();
    const env = await orchestrator.launch({
      ...input,
      repo: resolveRepoConfig({ mode: "readOnly", gitCredentials: "none" }),
    });
    try {
      const launch = deps.hostOpencodeBootstrap.startInputs[0];
      expect(launch?.hostLaunchWrapperPath).toBe("/host/payload/launch.sh");
      expect(launch?.expectedVersion).toBe(FAKE_PAYLOAD_VERSION);
      expect(launch?.providerEnv["SCARN_TEST_TOKEN"]).toBe("secret-token");
      expect(launch?.providerEnv["SCARN_PROVIDER_BASE_URL"]).toBe(
        "https://api.example.com",
      );
      expect(launch?.credentials).toEqual([FAKE_CREDENTIAL]);
      expect(() => {
        JSON.parse(launch?.opencodeConfigContent ?? "");
      }).not.toThrow();
      expect(env.agent?.password).toBe(FAKE_SERVER_PASSWORD);
      expect(env.agent?.version).toBe(FAKE_PAYLOAD_VERSION);
      expect(env.aiImage).toBe(`opencode-runtime@${FAKE_PAYLOAD_VERSION}`);
      expect(env.resolvedBranch).toBe("main");
      expect(env.workBranch).toBeNull();
      expect(env.createdFromBranch).toBeNull();
      expect(env.devcontainerConfigPath).toBe("");
      expect(env.networkName).toBe("");
    } finally {
      await env.cleanup();
    }
  });

  test("prepares an agentless host checkout without provisioning an agent", async () => {
    const { deps, input, orchestrator } = setup();
    const env = await orchestrator.launch({ ...input, startAgent: false });
    expect(env.agent).toBeNull();
    expect(deps.hostOpencodeBootstrap.startInputs).toEqual([]);
    await env.cleanup();
  });

  test("clones, prepares execution files, resolves repo MCP refs and starts in the checkout", async () => {
    const { log, deps, input, orchestrator } = setup();
    await mkdir(path.join(workspacePath, ".opencode"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".opencode/opencode.json"),
      JSON.stringify({
        mcp: { database: { type: "local", command: ["pg-mcp"] } },
      }),
    );
    const onAgentLogReady = vi.fn();
    const start = vi
      .spyOn(deps.hostOpencodeBootstrap, "start")
      .mockImplementation(async (launch) => {
        expect(log).toContain("clone");
        expect(
          JSON.parse(
            await readFile(
              path.join(
                workspacePath,
                ".scarn/current-execution/execution.json",
              ),
              "utf8",
            ),
          ),
        ).toMatchObject({ taskRunId: input.currentExecutionInfo.taskRunId });
        expect(
          await readFile(
            path.join(workspacePath, ".scarn/previous/findings.json"),
            "utf8",
          ),
        ).toContain("previous finding");
        launch.onLogReady?.({
          agentLogDirectory: "/host/log",
          agentLogPath: "/host/log/serve.log",
        });
        return {
          pid: 12345,
          agentBaseUrl: "http://localhost:54321",
          serverPassword: "password",
          agentLogDirectory: "/host/log",
          agentLogPath: "/host/log/serve.log",
        };
      });
    const env = await orchestrator.launch({
      ...input,
      repo: resolveRepoConfig({ mode: "readOnly", gitCredentials: "none" }),
      onAgentLogReady,
      opencodeMcpJson: {
        db: { type: "ref", name: "database", codemode: true },
      },
      stepEnv: { HOST_SECRET: "host-secret" },
      previousRun: {
        run: {
          status: "succeeded",
          taskRunId: input.currentExecutionInfo.taskRunId,
          findingsJson: { summary: "previous finding" },
          findingsRelativePath: ".scarn/previous/findings.json",
          transcriptRelativePath: ".scarn/previous/transcript.md",
        },
        stepKey: "host",
        loadLogLines: () => Promise.resolve({ unavailable: "test" }),
      },
    });
    const launch = start.mock.calls[0]?.[0];
    expect(launch?.workspaceFolder).toBe(workspacePath);
    expect(launch?.stepEnv).toEqual({ HOST_SECRET: "host-secret" });
    expect(
      (
        JSON.parse(launch?.opencodeConfigContent ?? "{}") as {
          mcp: { servers: Record<string, unknown> };
        }
      ).mcp.servers["db"],
    ).toMatchObject({ type: "local", command: ["pg-mcp"] });
    expect(onAgentLogReady).toHaveBeenCalledWith(
      expect.objectContaining({
        hostLogPath: "/host/log/serve.log",
        secretValues: [
          "https://api.example.com",
          "secret-token",
          "fake-credential-secret",
        ],
      }),
    );
    expect(env.secretValues).toContain("secret-token");
    expect(env.workspaceFolder).toBe(workspacePath);
    expect(env.runtimeContainerId).toBeNull();
    expect("checkContainerHealth" in env).toBe(false);
    expect(env.commitAndPushWorkBranch).toBeUndefined();
    expect(deps.devcontainerLauncher.resolveConfigInputs).toEqual([]);
    expect(deps.devcontainerLauncher.launchInputs).toEqual([]);
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
    expect(deps.gitCredentialRelay.openInputs).toEqual([]);
    await env.cleanup();
    expect(deps.hostOpencodeBootstrap.stopCalls).toEqual([12345]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspacePath]);
    expect(
      await access(resolveSessionAgentHomeDir(input.sessionId)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("readWrite host runs share work branch creation, commit and push", async () => {
    const { deps, input, orchestrator, commitPush } = setup();
    const env = await orchestrator.launch({
      ...input,
      stepKey: "implement",
      baseWorkBranch: "scarn/predecessor",
      repo: resolveRepoConfig(),
    });
    expect(commitPush.checkoutBaseCalls).toEqual(["scarn/predecessor"]);
    expect(env.createdFromBranch).toBe("scarn/predecessor");
    const workBranch = `scarn/implement-${input.currentExecutionInfo.taskRunId}`;
    expect(env.workBranch).toBe(workBranch);
    expect(deps.hostOpencodeBootstrap.startInputs).toHaveLength(1);
    await env.commitAndPushWorkBranch?.({ result: {} });
    expect(commitPush.commitAllCalls).toBe(1);
    expect(commitPush.pushCalls).toEqual([workBranch]);
    expect(commitPush.commitAllExcludePaths[0]).not.toContain("");
    expect(deps.gitCredentialRelay.openInputs).toEqual([]);
    await env.cleanup();
  });

  test("production launch accepts a host conversation and forwards its pinned checkout", async () => {
    const { deps, input, orchestrator } = setup();
    const workerClient = createWorkerClient(input.environment);
    const routingDeps = createRoutingDeps({
      workerClient,
      workspaceOrchestrator: createRecordingOrchestrator(workspacePath),
    });
    routingDeps.runtimeEnvironmentOrchestrator = orchestrator;
    const context = createWorkerContext(input.environment);
    const baseCommit = "d".repeat(40);
    const env = await launchRuntimeEnvironment(routingDeps, {
      startAgent: true,
      claimToken: input.claimToken,
      localRuntimeSessionId: input.sessionId,
      requestedByUserId: input.requestedByUserId,
      workerContext: {
        ...context,
        task: { ...context.task, conversationId: input.projectId },
        baseCommit,
      },
      reporter: noopReporter,
      taskRunId: context.task.id,
    });
    expect(deps.repoContextGit.checkoutCalls).toEqual([baseCommit]);
    expect(deps.hostOpencodeBootstrap.startInputs).toHaveLength(1);
    expect(env.runtimeContainerId).toBeNull();
    await env.cleanup();
  });

  test.each([null, "a".repeat(40)])(
    "conversation checks out the stored pin before host launch (baseCommit %p)",
    async (baseCommit) => {
      const { deps, input, orchestrator, commitPush } = setup();
      const storedCommit = "b".repeat(40);
      deps.repoContextGit.branchCommits.set("main", "c".repeat(40));
      const pinBaseCommit = vi.fn(() => Promise.resolve(storedCommit));
      const start = deps.hostOpencodeBootstrap.start.bind(
        deps.hostOpencodeBootstrap,
      );
      deps.hostOpencodeBootstrap.start = async (launch) => {
        expect(deps.repoContextGit.checkoutCalls).toEqual([
          baseCommit ?? storedCommit,
        ]);
        return await start(launch);
      };
      const env = await orchestrator.launch({
        ...input,
        repo: resolveRepoConfig({ mode: "readOnly", gitCredentials: "none" }),
        repoContext: { baseCommit, pinBaseCommit },
      });
      expect(pinBaseCommit).toHaveBeenCalledTimes(baseCommit ? 0 : 1);
      expect(commitPush.createBranchCalls).toEqual([]);
      expect(env.commitAndPushWorkBranch).toBeUndefined();
      await env.cleanup();
    },
  );

  test.each([false, true])(
    "stops a started host after assembly failure while preserving artifacts only (%p)",
    async (preserveRuntimeOnFailure) => {
      const { deps, input, orchestrator } = setup();
      const failure = new Error("commit closure assembly failed");
      const error = await rejectionOf(
        orchestrator.launch({
          ...input,
          stepKey: "implement",
          preserveRuntimeOnFailure,
          repo: {
            mode: "readWrite",
            gitCredentials: "none",
            onPushFailure: "fail",
            baseBranch: null,
            workBranch: { kind: "create" },
            get message(): string {
              throw failure;
            },
          },
        }),
      );
      expect(error).toBe(failure);
      expect(deps.hostOpencodeBootstrap.startInputs).toHaveLength(1);
      expect(deps.hostOpencodeBootstrap.stopCalls).toEqual([12345]);
      expect(deps.workspaceManager.removeCalls).toEqual(
        preserveRuntimeOnFailure ? [] : [workspacePath],
      );
      expect(
        await access(resolveSessionAgentHomeDir(input.sessionId)).then(
          () => true,
          () => false,
        ),
      ).toBe(preserveRuntimeOnFailure);
      expect(deps.devcontainerLauncher.stopCalls).toEqual([]);
      expect(deps.opencodeBootstrap.stopCalls).toEqual([]);
    },
  );

  test.each([false, true])(
    "host launch failure cleans up unless preserved (%p)",
    async (preserveRuntimeOnFailure) => {
      const { deps, input, orchestrator } = setup();
      deps.hostOpencodeBootstrap.shouldFail = true;
      const onAgentLogReady = vi.fn();
      expect(
        await rejectionOf(
          orchestrator.launch({
            ...input,
            preserveRuntimeOnFailure,
            onAgentLogReady,
          }),
        ),
      ).toMatchObject({ message: "host boot failed" });
      expect(onAgentLogReady).toHaveBeenCalledWith({
        hostLogPath: path.join(
          resolveSessionAgentHomeDir(input.sessionId),
          ".scarn-log/opencode-serve.log",
        ),
        logDirectory: path.join(
          resolveSessionAgentHomeDir(input.sessionId),
          ".scarn-log",
        ),
        secretValues: [
          "https://api.example.com",
          "secret-token",
          "fake-credential-secret",
        ],
      });
      expect(deps.hostOpencodeBootstrap.stopCalls).toEqual([]);
      expect(deps.workspaceManager.removeCalls).toEqual(
        preserveRuntimeOnFailure ? [] : [workspacePath],
      );
      expect(
        await access(resolveSessionAgentHomeDir(input.sessionId)).then(
          () => true,
          () => false,
        ),
      ).toBe(preserveRuntimeOnFailure);
      expect(deps.devcontainerLauncher.stopCalls).toEqual([]);
    },
  );
});
