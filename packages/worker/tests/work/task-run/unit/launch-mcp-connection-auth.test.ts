/**
 * A launch whose step uses a managed connection registers the run's managed
 * launch before OpenCode starts and points each connection-auth server at the
 * relay: the relay URL, the capability as a bearer header and OpenCode's OAuth
 * off. The repository's headers and the Notion URL never reach the config, the
 * capability is masked, and a not-ready connection fails the launch before
 * the payload, devcontainer or OpenCode starts. Logs name keys, sources and
 * connections only, never a dropped header value.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  vi,
} from "bun:test";
import type { OpenCodeMcpServers } from "../../../../src/common/contracts/opencode-mcp";
import { createUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import {
  HostOpencodeBootstrap,
  type HostStartInput,
  type HostStartResult,
} from "../../../../src/runtime/runtime-service/infra/host-opencode-bootstrap";
import { resolveSessionAgentHomeDir } from "../../../../src/runtime/runtime-service/infra/opencode-agent-home";
import { ManagedConnectionNotReadyError } from "../../../../src/work/task-run/application/managed-connection-not-ready-error";
import { planStepEnv } from "../../../../src/work/task-run/application/resolve-step-env";
import * as workLogger from "../../../../src/work/task-run/application/work-logger";
import type { RegisterManagedLaunch } from "../../../../src/work/task-run/contracts/managed-launch-types";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../../../../src/work/task-run/infra/local-project-runtime-environment";
import {
  buildLaunchInput,
  buildOrchestratorFakeDeps,
  rejectionOf,
  type CallLog,
} from "./helpers/orchestrator-launch-fakes";

const NOTION_URL = "https://mcp.notion.com/mcp";
const TOKEN_VAR = "NOTION_TOKEN";
const RELAY_URL = "http://host.docker.internal:3000/api/mcp-relay/launch-1";
const CAPABILITY = "synthetic-relay-capability-9c2e";

let workspace: string;
let providerOutputDir: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-connection-launch-"));
  providerOutputDir = await mkdtemp(
    path.join(os.tmpdir(), "mcp-connection-auth-provider-"),
  );
});

afterEach(async () => {
  await Promise.all(
    [workspace, providerOutputDir].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function writeRepoServers(servers: Record<string, object>) {
  await mkdir(path.join(workspace, ".opencode"), { recursive: true });
  await writeFile(
    path.join(workspace, ".opencode", "opencode.json"),
    JSON.stringify({ mcp: { servers } }),
  );
}

const repoNotion = {
  type: "remote" as const,
  url: NOTION_URL,
  headers: {
    Authorization: `Bearer {env:${TOKEN_VAR}}`,
    "X-Trace": "{env:NOTION_TRACE}",
  },
  oauth: { scope: "read" },
};

function relayRegistration() {
  return vi.fn<RegisterManagedLaunch>(() =>
    Promise.resolve({
      notion: { relayUrl: RELAY_URL, capability: CAPABILITY },
    }),
  );
}

type ConfigServer = Record<string, unknown> | undefined;

function configServers(configContent: string | undefined) {
  return (
    JSON.parse(configContent ?? "{}") as {
      mcp: { servers: Record<string, ConfigServer> };
    }
  ).mcp.servers;
}

function expectRelayEntry(server: ConfigServer) {
  expect(server).toMatchObject({
    type: "remote",
    url: RELAY_URL,
    oauth: false,
  });
  expect(server?.["headers"]).toEqual({
    Authorization: `Bearer ${CAPABILITY}`,
  });
}

function expectNoRepositoryAuth(configContent: string | undefined) {
  expect(configContent).not.toContain("mcp.notion.com");
  expect(configContent).not.toContain("X-Trace");
  expect(configContent).not.toContain(`{env:${TOKEN_VAR}}`);
  expect(configContent).not.toContain('"scope"');
}

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

function workspaceLaunch(
  opencodeMcpJson: OpenCodeMcpServers,
  registerManagedLaunch: RegisterManagedLaunch | undefined,
) {
  const log: CallLog = [];
  const deps = buildOrchestratorFakeDeps({
    workspacePath: workspace,
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
    workerEnv: {},
    opencodeMcpJson,
  });
  const launched = orchestrator.launch({
    ...buildLaunchInput(),
    opencodeMcpJson,
    stepEnv: resolved.stepEnv,
    resolveMcpEnv,
    registerManagedLaunch,
  });
  return { launched, log, deps };
}

describe("launch with connection auth points at the managed relay", () => {
  const steps: { name: string; servers: OpenCodeMcpServers }[] = [
    {
      name: "a ref with auth",
      servers: { notion: { type: "ref", auth: { connection: "notion" } } },
    },
    {
      name: "an inline remote with auth",
      servers: {
        notion: {
          type: "remote",
          url: NOTION_URL,
          auth: { connection: "notion" },
        },
      },
    },
  ];

  for (const { name, servers } of steps) {
    test(`${name}: workspace config has the relay entry and the capability is masked`, async () => {
      await writeRepoServers({ notion: repoNotion });
      const register = relayRegistration();
      const { launched, deps } = workspaceLaunch(servers, register);
      const env = await launched;
      try {
        expect(register).toHaveBeenCalledTimes(1);
        expect(register).toHaveBeenCalledWith({
          runtimeKind: "devcontainer",
          entries: { notion: { url: NOTION_URL } },
          remotesWithoutAuth: {},
        });
        const content =
          deps.opencodeBootstrap.startInputs[0]?.opencodeConfigContent;
        expectRelayEntry(configServers(content)["notion"]);
        expectNoRepositoryAuth(content);
        expect(env.secretValues).toContain(CAPABILITY);
      } finally {
        await env.cleanup();
      }
    });
  }

  test("a mixed step launches with the relay entry beside its ordinary servers", async () => {
    await writeRepoServers({
      notion: repoNotion,
      db: { type: "local", command: ["pg-mcp"] },
    });
    const { launched, deps } = workspaceLaunch(
      {
        db: { type: "ref" },
        notion: { type: "ref", auth: { connection: "notion" } },
        playwright: { type: "local", command: ["npx", "@playwright/mcp"] },
      },
      relayRegistration(),
    );
    const env = await launched;
    try {
      const content =
        deps.opencodeBootstrap.startInputs[0]?.opencodeConfigContent;
      const servers = configServers(content);
      expectRelayEntry(servers["notion"]);
      expect(servers["db"]).toMatchObject({
        type: "local",
        command: ["pg-mcp"],
      });
      expect(servers["playwright"]).toMatchObject({
        type: "local",
        command: ["npx", "@playwright/mcp"],
      });
      expectNoRepositoryAuth(content);
    } finally {
      await env.cleanup();
    }
  });

  test("logs name the keys, sources and dropped header names, never a value", async () => {
    await writeRepoServers({ notion: repoNotion });
    const info = spyOn(workLogger, "logWork");
    try {
      const { launched } = workspaceLaunch(
        {
          docs: { type: "ref", name: "notion", auth: { connection: "notion" } },
        },
        vi.fn<RegisterManagedLaunch>(() =>
          Promise.resolve({
            docs: { relayUrl: RELAY_URL, capability: CAPABILITY },
          }),
        ),
      );
      const env = await launched;
      await env.cleanup();

      const [, , details] =
        info.mock.calls.find(
          ([, message]) => message === "MCP server uses a managed connection",
        ) ?? [];
      expect(details).toMatchObject({
        key: "docs",
        connection: "notion",
        source: ".opencode/opencode.json",
        droppedHeaders: ["Authorization", "X-Trace"],
        droppedOAuth: true,
      });
      const [, , relayed] =
        info.mock.calls.find(
          ([, message]) =>
            message === "Managed connection MCP servers point at the relay",
        ) ?? [];
      expect(relayed).toMatchObject({ keys: ["docs"] });
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain("Bearer");
      expect(logged).not.toContain(`{env:${TOKEN_VAR}}`);
      expect(logged).not.toContain(CAPABILITY);
      expect(logged).not.toContain('"scope"');
    } finally {
      info.mockRestore();
    }
  });

  test("a not-ready connection fails before the payload, devcontainer or OpenCode starts", async () => {
    await writeRepoServers({ notion: repoNotion });
    const notReady = new ManagedConnectionNotReadyError({
      key: "notion",
      state: "needs_reconnect",
      reasonCode: "refresh_failed",
    });
    const { launched, log, deps } = workspaceLaunch(
      { notion: { type: "ref", auth: { connection: "notion" } } },
      () => Promise.reject(notReady),
    );

    expect(await rejectionOf(launched)).toBe(notReady);
    expect(log).not.toContain("ensurePayload");
    expect(log).not.toContain("launchDevcontainer");
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
  });

  test("a launch that can't register fails before anything starts", async () => {
    await writeRepoServers({ notion: repoNotion });
    const { launched, log, deps } = workspaceLaunch(
      { notion: { type: "ref", auth: { connection: "notion" } } },
      undefined,
    );

    const error = await rejectionOf(launched);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"notion"');
    expect(log).not.toContain("launchDevcontainer");
    expect(deps.opencodeBootstrap.startInputs).toEqual([]);
  });

  test("a step without connection auth never registers", async () => {
    await writeRepoServers({ db: { type: "local", command: ["pg-mcp"] } });
    const register = relayRegistration();
    const { launched } = workspaceLaunch({ db: { type: "ref" } }, register);
    const env = await launched;
    await env.cleanup();

    expect(register).not.toHaveBeenCalled();
    expect(env.secretValues).not.toContain(CAPABILITY);
  });

  test("a step without auth at a connection-like URL launches without registering", async () => {
    await writeRepoServers({ notion: { type: "remote", url: NOTION_URL } });
    const register = relayRegistration();
    const { launched } = workspaceLaunch({ notion: { type: "ref" } }, register);
    const env = await launched;
    await env.cleanup();

    expect(register).not.toHaveBeenCalled();
  });

  test("host launch writes the relay entry and masks the capability", async () => {
    await writeRepoServers({ notion: repoNotion });
    const deps = buildOrchestratorFakeDeps({
      workspacePath: workspace,
      providerOutputDir,
      log: [],
    });
    const hostOpencodeBootstrap = new FakeHostOpencodeBootstrap();
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      { ...deps, hostOpencodeBootstrap },
    );
    const sessionId = createUuidV7();
    const register = relayRegistration();
    const onSecretValues = vi.fn();

    try {
      const env = await orchestrator.launch({
        ...buildLaunchInput(),
        environment: { kind: "inline", runtime: { kind: "host" } },
        sessionId,
        repo: { mode: "readOnly", gitCredentials: "none", baseBranch: null },
        opencodeMcpJson: {
          notion: { type: "ref", auth: { connection: "notion" } },
        },
        registerManagedLaunch: register,
        onSecretValues,
      });
      await env.cleanup();

      expect(register).toHaveBeenCalledWith({
        runtimeKind: "host",
        entries: { notion: { url: NOTION_URL } },
        remotesWithoutAuth: {},
      });
      const content =
        hostOpencodeBootstrap.startInputs[0]?.opencodeConfigContent;
      expectRelayEntry(configServers(content)["notion"]);
      expectNoRepositoryAuth(content);
      expect(env.secretValues).toContain(CAPABILITY);
      expect(onSecretValues).toHaveBeenCalledWith(
        expect.arrayContaining([CAPABILITY]),
      );
    } finally {
      await rm(resolveSessionAgentHomeDir(sessionId), {
        recursive: true,
        force: true,
      });
    }
  });

  test("a not-ready connection fails a host launch before OpenCode starts", async () => {
    await writeRepoServers({ notion: repoNotion });
    const deps = buildOrchestratorFakeDeps({
      workspacePath: workspace,
      providerOutputDir,
      log: [],
    });
    const hostOpencodeBootstrap = new FakeHostOpencodeBootstrap();
    const orchestrator = new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
      undefined,
      { ...deps, hostOpencodeBootstrap },
    );
    const notReady = new ManagedConnectionNotReadyError();

    const error = await rejectionOf(
      orchestrator.launch({
        ...buildLaunchInput(),
        environment: { kind: "inline", runtime: { kind: "host" } },
        repo: { mode: "readOnly", gitCredentials: "none", baseBranch: null },
        opencodeMcpJson: {
          notion: { type: "ref", auth: { connection: "notion" } },
        },
        registerManagedLaunch: () => Promise.reject(notReady),
      }),
    );

    expect(error).toBe(notReady);
    expect(hostOpencodeBootstrap.startInputs).toEqual([]);
    expect(deps.workspaceManager.removeCalls).toEqual([workspace]);
  });
});
