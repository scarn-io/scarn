import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildOpencodeContext } from "@scarn/opencode-plugin";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import { LAUNCH_WRAPPER_FILENAME } from "../../../runtime/runtime-service/domain/opencode-runtime-payload";
import type { HostOpencodeBootstrap } from "../../../runtime/runtime-service/infra/host-opencode-bootstrap";
import { prepareAgentHomeConfig } from "../../../runtime/runtime-service/infra/opencode-agent-home";
import {
  opencodeCredentialSecrets,
  type OpencodeCredentialLoader,
} from "../../../runtime/runtime-service/infra/opencode-credential-source";
import type { OpencodeRuntimePayloadProvisioner } from "../../../runtime/runtime-service/infra/opencode-runtime-payload-provisioner";
import type {
  McpEnvRef,
  ResolvedStepEnv,
} from "../application/resolve-step-env";
import { logWork, logWorkWarn } from "../application/work-logger";
import type { ProviderAccessResolver } from "../contracts/agent-runtime/provider-access-resolver";
import type { RuntimeConfigMaterializer } from "../contracts/agent-runtime/runtime-config-materializer";
import type { RegisterLaunchServers } from "../contracts/managed-launch-types";
import type { AgentRuntime } from "../contracts/process-project-work-types";
import type { WorkReporter } from "../contracts/work-reporter";
import { buildFakeProviderConfig } from "./fake-ai";
import {
  applyStepMcpEnv,
  planStepMcpServers,
} from "./resolve-launch-mcp-servers";

export type HostAgentLaunchDeps = {
  payloadProvisioner: OpencodeRuntimePayloadProvisioner;
  providerAccessResolver: ProviderAccessResolver;
  runtimeConfigMaterializer: RuntimeConfigMaterializer;
  hostOpencodeBootstrap: HostOpencodeBootstrap;
  loadCredentials: OpencodeCredentialLoader;
};

/**
 * Prepares and starts a host agent in an existing workspace. The caller owns
 * the workspace, session HOME and returned process, including their cleanup.
 * The bootstrap reaps processes whose startup fails before returning a PID.
 */
export async function startHostAgent(input: {
  deps: HostAgentLaunchDeps;
  sessionId: UuidV7;
  projectId: UuidV7;
  requestedByUserId: UuidV7;
  workspacePath: string;
  sessionAgentHomeDir: string;
  opencodeMcpJson?: OpenCodeMcpServers | null | undefined;
  connectors?: readonly string[] | undefined;
  fakeAiProviderOverride?: { baseUrl: string } | undefined;
  stepEnv?: Readonly<Record<string, string>> | undefined;
  resolveMcpEnv?: ((refs: readonly McpEnvRef[]) => ResolvedStepEnv) | undefined;
  registerManagedLaunch?: RegisterLaunchServers | undefined;
  reporter: WorkReporter;
  taskRunId: string;
  onSecretValues?: ((values: readonly string[]) => void) | undefined;
  onAgentLogReady?:
    | ((log: {
        logDirectory: string;
        hostLogPath: string;
        secretValues: readonly string[];
      }) => void)
    | undefined;
}): Promise<{
  agent: AgentRuntime;
  payloadVersion: string;
  secretValues: string[];
  pid: number;
}> {
  const { deps, workspacePath, sessionAgentHomeDir } = input;
  const mcpLaunch = applyStepMcpEnv({
    plan: await planStepMcpServers({
      servers: input.opencodeMcpJson,
      connectors: input.connectors,
      workspacePath,
      sessionId: input.sessionId,
      registerManagedLaunch: input.registerManagedLaunch,
    }),
    stepEnv: input.stepEnv,
    resolveMcpEnv: input.resolveMcpEnv,
  });
  const { opencodeConfigContent } = await buildOpencodeContext({
    workspacePath,
    stepMcpServers: mcpLaunch.servers,
    providerOverride: input.fakeAiProviderOverride
      ? buildFakeProviderConfig(input.fakeAiProviderOverride.baseUrl)
      : undefined,
  });
  logWork("runtime", "OpenCode context built (host)", {
    sessionId: input.sessionId,
    workspacePath,
  });

  const payload = await deps.payloadProvisioner.ensure();
  const hostLaunchWrapperPath = path.join(
    payload.hostPayloadDir,
    LAUNCH_WRAPPER_FILENAME,
  );
  logWork("runtime", "OpenCode runtime payload ready (host)", {
    sessionId: input.sessionId,
    version: payload.version,
    hostPayloadDir: payload.hostPayloadDir,
    hostLaunchWrapperPath,
  });

  const providerAccess = await deps.providerAccessResolver.resolve({
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestedByUserId: input.requestedByUserId,
  });
  const materialized = await deps.runtimeConfigMaterializer.materialize({
    runtimeContainerId: input.sessionId,
    workspaceFolder: workspacePath,
    providerAccess,
  });
  logWork("runtime", "Provider access resolved (host)", {
    sessionId: input.sessionId,
    providerMode: providerAccess.mode,
    providerEnvKeys: Object.keys(materialized.env).sort(),
  });

  const credentials = await deps.loadCredentials({
    launcherPath: hostLaunchWrapperPath,
    onWarning: (message) => {
      logWorkWarn("runtime", message, { sessionId: input.sessionId });
    },
  });
  logWork("runtime", "OpenCode credentials loaded (host)", {
    sessionId: input.sessionId,
    integrations: credentials.map(({ integrationID, source }) => ({
      integrationID,
      source,
    })),
  });
  const secretValues = [
    ...Object.values(materialized.env),
    ...opencodeCredentialSecrets(credentials),
    ...mcpLaunch.secretValues,
  ];
  input.onSecretValues?.(secretValues);

  await mkdir(sessionAgentHomeDir, { recursive: true });
  const { hostConfigPath } = await prepareAgentHomeConfig({
    sessionAgentHomeDir,
  });
  logWork("runtime", "Agent HOME global config prepared (host)", {
    sessionId: input.sessionId,
    hostConfigPath: hostConfigPath ?? "(none)",
  });

  input.reporter.event({
    type: "task:runtime-ai-starting",
    taskRunId: input.taskRunId,
  });
  const started = await deps.hostOpencodeBootstrap.start({
    hostLaunchWrapperPath,
    workspaceFolder: workspacePath,
    sessionAgentHomeDir,
    providerEnv: materialized.env,
    credentials,
    stepEnv: mcpLaunch.stepEnv,
    opencodeConfigContent,
    expectedVersion: payload.version,
    onLogReady: ({ agentLogDirectory, agentLogPath }) => {
      input.onAgentLogReady?.({
        logDirectory: agentLogDirectory,
        hostLogPath: agentLogPath,
        secretValues,
      });
    },
  });
  logWork("runtime", "Host OpenCode started (host)", {
    sessionId: input.sessionId,
    agentBaseUrl: started.agentBaseUrl,
    pid: started.pid,
    workspacePath,
  });

  return {
    agent: {
      baseUrl: started.agentBaseUrl,
      password: started.serverPassword,
      version: payload.version,
      logDirectory: started.agentLogDirectory,
      hostLogPath: started.agentLogPath,
    },
    payloadVersion: payload.version,
    secretValues,
    pid: started.pid,
  };
}
