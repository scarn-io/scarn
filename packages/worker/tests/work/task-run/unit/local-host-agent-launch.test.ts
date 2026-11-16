import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import {
  HostOpencodeBootstrap,
  type HostStartInput,
  type HostStartResult,
} from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { OpencodeRuntimePayloadProvisioner } from "../../../../src/runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import type { OpencodeCredentialLoader } from "../../../../src/runtime/runtime-service/infra/opencode-credential-source";
import { noopReporter } from "../../../../src/work/task-run/contracts/work-reporter";
import { startHostAgent } from "../../../../src/work/task-run/infra/local-host-agent-launch";
import { FAKE_CREDENTIAL } from "./helpers/orchestrator-launch-fakes";

const payload = {
  version: "1.17.3-test",
  hostPayloadDir: "/host/payload",
  containerPayloadDir: "/container/payload",
  containerLaunchWrapperPath: "/container/payload/launch.sh",
};

class FakePayloadProvisioner extends OpencodeRuntimePayloadProvisioner {
  override ensure = mock(() => Promise.resolve(payload));
}

class FakeHostBootstrap extends HostOpencodeBootstrap {
  failure: Error | undefined;
  override start = mock((input: HostStartInput): Promise<HostStartResult> => {
    const agentLogDirectory = path.join(input.sessionAgentHomeDir, ".scarn-log");
    const agentLogPath = path.join(agentLogDirectory, "opencode-serve.log");
    input.onLogReady?.({ agentLogDirectory, agentLogPath });
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({
      agentBaseUrl: "http://127.0.0.1:54999",
      serverPassword: "server-password",
      agentLogDirectory,
      agentLogPath,
      pid: 424242,
    });
  });
  override stop = mock((pid: number | null | undefined) => {
    void pid;
  });
}

describe("startHostAgent", () => {
  let root: string;
  let workspacePath: string;
  let sessionAgentHomeDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "host-agent-launch-"));
    workspacePath = path.join(root, "existing-checkout");
    sessionAgentHomeDir = path.join(root, "caller-owned-home");
    await mkdir(workspacePath);
    await writeFile(path.join(workspacePath, "keep.txt"), "existing checkout");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function launchInput() {
    const providerAccess = { mode: "direct" as const };
    return {
      deps: {
        payloadProvisioner: new FakePayloadProvisioner(),
        providerAccessResolver: {
          resolve: mock(() => Promise.resolve(providerAccess)),
        },
        runtimeConfigMaterializer: {
          materialize: mock(() =>
            Promise.resolve({ env: { PROVIDER_TOKEN: "provider-secret" } }),
          ),
        },
        hostOpencodeBootstrap: new FakeHostBootstrap(),
        loadCredentials: mock(
          (input: Parameters<OpencodeCredentialLoader>[0]) => {
            void input;
            return Promise.resolve([FAKE_CREDENTIAL]);
          },
        ),
      },
      workspacePath,
      sessionAgentHomeDir,
      sessionId: createUuidV7(),
      projectId: createUuidV7(),
      requestedByUserId: createUuidV7(),
      reporter: { ...noopReporter, event: mock(() => {}) },
      taskRunId: createUuidV7(),
    };
  }

  test("prepares a caller-owned HOME and launches in the existing workspace with injected dependencies", async () => {
    const input = launchInput();
    const result = await startHostAgent({
      ...input,
      stepEnv: { ACCOUNT_ID: "acct-1" },
    });

    expect(input.deps.payloadProvisioner.ensure).toHaveBeenCalledTimes(1);
    expect(input.deps.providerAccessResolver.resolve).toHaveBeenCalledWith({
      sessionId: input.sessionId,
      projectId: input.projectId,
      requestedByUserId: input.requestedByUserId,
    });
    expect(input.deps.runtimeConfigMaterializer.materialize).toHaveBeenCalledWith({
      runtimeContainerId: input.sessionId,
      workspaceFolder: workspacePath,
      providerAccess: { mode: "direct" },
    });
    expect(input.deps.loadCredentials).toHaveBeenCalledTimes(1);
    expect(input.deps.loadCredentials.mock.calls[0]?.[0]?.launcherPath).toBe(
      "/host/payload/launch.sh",
    );
    expect(
      typeof input.deps.loadCredentials.mock.calls[0]?.[0]?.onWarning,
    ).toBe("function");
    const start = input.deps.hostOpencodeBootstrap.start.mock.calls[0]?.[0];
    expect(input.deps.hostOpencodeBootstrap.start).toHaveBeenCalledWith({
      hostLaunchWrapperPath: "/host/payload/launch.sh",
      workspaceFolder: workspacePath,
      sessionAgentHomeDir,
      providerEnv: { PROVIDER_TOKEN: "provider-secret" },
      credentials: [FAKE_CREDENTIAL],
      stepEnv: { ACCOUNT_ID: "acct-1" },
      opencodeConfigContent: start?.opencodeConfigContent,
      expectedVersion: payload.version,
      onLogReady: start?.onLogReady,
    });
    expect(typeof start?.opencodeConfigContent).toBe("string");
    expect(typeof start?.onLogReady).toBe("function");
    expect(result).toEqual({
      agent: {
        baseUrl: "http://127.0.0.1:54999",
        password: "server-password",
        version: payload.version,
        logDirectory: path.join(sessionAgentHomeDir, ".scarn-log"),
        hostLogPath: path.join(
          sessionAgentHomeDir,
          ".scarn-log",
          "opencode-serve.log",
        ),
      },
      payloadVersion: payload.version,
      secretValues: ["provider-secret", "fake-credential-secret"],
      pid: 424242,
    });
    expect(input.reporter.event).toHaveBeenCalledWith({
      type: "task:runtime-ai-starting",
      taskRunId: input.taskRunId,
    });
    expect(await readFile(path.join(workspacePath, "keep.txt"), "utf8")).toBe(
      "existing checkout",
    );
    expect((await stat(sessionAgentHomeDir)).isDirectory()).toBe(true);
    expect(input.deps.hostOpencodeBootstrap.stop).not.toHaveBeenCalled();
  });

  test("passes inline MCP and fake-provider configuration to the bootstrap", async () => {
    const input = launchInput();
    await startHostAgent({
      ...input,
      opencodeMcpJson: {
        warehouse: { type: "local", command: ["warehouse-mcp"] },
      },
      fakeAiProviderOverride: { baseUrl: "http://127.0.0.1:4567" },
    });

    const start = input.deps.hostOpencodeBootstrap.start.mock.calls[0]?.[0];
    const config = JSON.parse(start?.opencodeConfigContent ?? "") as {
      mcp: { servers: Record<string, unknown> };
    };
    expect(config.mcp.servers["warehouse"]).toMatchObject({
      type: "local",
      command: ["warehouse-mcp"],
    });
    expect(start?.opencodeConfigContent).toContain("http://127.0.0.1:4567");
  });

  test("resolves MCP env before launch and includes its secrets in the result and early log callback", async () => {
    const input = launchInput();
    const onAgentLogReady = mock(() => {});
    const resolveMcpEnv = mock(() => ({
      stepEnv: { MCP_TOKEN: "mcp-secret" },
      setupEnv: {},
      promptEnv: {},
      secretValues: ["mcp-secret"],
    }));
    const result = await startHostAgent({
      ...input,
      stepEnv: { SUPERSEDED: "unused" },
      resolveMcpEnv,
      onAgentLogReady,
    });

    expect(resolveMcpEnv).toHaveBeenCalledWith([]);
    expect(
      input.deps.hostOpencodeBootstrap.start.mock.calls[0]?.[0].stepEnv,
    ).toEqual({ MCP_TOKEN: "mcp-secret" });
    expect(result.secretValues).toEqual([
      "provider-secret",
      "fake-credential-secret",
      "mcp-secret",
    ]);
    expect(onAgentLogReady).toHaveBeenCalledWith({
      logDirectory: result.agent.logDirectory,
      hostLogPath: result.agent.hostLogPath,
      secretValues: result.secretValues,
    });
  });

  test("rejects a missing MCP ref before provisioning or starting an agent", async () => {
    const input = launchInput();
    let error: unknown;
    try {
      await startHostAgent({
        ...input,
        opencodeMcpJson: { missing: { type: "ref", name: "missing" } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(input.deps.payloadProvisioner.ensure).not.toHaveBeenCalled();
    expect(input.deps.hostOpencodeBootstrap.start).not.toHaveBeenCalled();
  });

  test("forwards early logs on failed startup without deleting caller-owned artifacts", async () => {
    const input = launchInput();
    const failure = new Error("host startup failed");
    input.deps.hostOpencodeBootstrap.failure = failure;
    const onAgentLogReady = mock(() => {});

    let error: unknown;
    try {
      await startHostAgent({ ...input, onAgentLogReady });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBe(failure);

    expect(onAgentLogReady).toHaveBeenCalledWith({
      logDirectory: path.join(sessionAgentHomeDir, ".scarn-log"),
      hostLogPath: path.join(
        sessionAgentHomeDir,
        ".scarn-log",
        "opencode-serve.log",
      ),
      secretValues: ["provider-secret", "fake-credential-secret"],
    });
    expect(await readFile(path.join(workspacePath, "keep.txt"), "utf8")).toBe(
      "existing checkout",
    );
    expect((await stat(sessionAgentHomeDir)).isDirectory()).toBe(true);
    expect(input.deps.hostOpencodeBootstrap.stop).not.toHaveBeenCalled();
  });

  test("discovers MCP refs in the supplied workspace and passes inferred env requirements to the resolver", async () => {
    await writeFile(
      path.join(workspacePath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          warehouse: {
            command: "warehouse-mcp",
            env: { TOKEN: "{env:WAREHOUSE_TOKEN}" },
          },
        },
      }),
    );
    const input = launchInput();
    const resolveMcpEnv = mock(() => ({
      stepEnv: { WAREHOUSE_TOKEN: "warehouse-secret" },
      setupEnv: {},
      promptEnv: {},
      secretValues: ["warehouse-secret"],
    }));

    await startHostAgent({
      ...input,
      opencodeMcpJson: { db: { type: "ref", name: "warehouse" } },
      resolveMcpEnv,
    });

    expect(resolveMcpEnv).toHaveBeenCalledWith([
      { key: "db", requiredEnv: ["WAREHOUSE_TOKEN"] },
    ]);
    const start = input.deps.hostOpencodeBootstrap.start.mock.calls[0]?.[0];
    const config = JSON.parse(start?.opencodeConfigContent ?? "") as {
      mcp: { servers: Record<string, unknown> };
    };
    expect(config.mcp.servers["db"]).toMatchObject({
      type: "local",
      command: ["warehouse-mcp"],
      environment: { TOKEN: "{env:WAREHOUSE_TOKEN}" },
    });
    expect(config.mcp.servers["warehouse"]).toMatchObject({ disabled: true });
  });
});
