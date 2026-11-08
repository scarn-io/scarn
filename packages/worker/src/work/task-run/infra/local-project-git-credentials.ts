/**
 * Step 3c of the single-container launch: when the worker offers git
 * credentials and the step's repo leaves `gitCredentials` at `"auto"`, open a
 * per-run git credential relay session and patch the cloned devcontainer.json
 * with its helper mount, host-gateway run args and `GIT_CONFIG_*` container
 * env. The relay is on by default, so a devcontainer that cannot take it
 * launches without it instead of failing. Kept out of the orchestrator so its
 * line count and logic stay small.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import { parseUuidV7, type UuidV7 } from "../../../common/contracts/uuid-v7";
import type { GitCredentialRunContext } from "../../../runtime/git-credentials/application/git-credential-source";
import type { GitCredentialRelaySession } from "../../../runtime/git-credentials/infra";
import {
  patchDevcontainerMounts,
  patchDevcontainerRunArgs,
} from "../../../runtime/runtime-service/infra/devcontainer-mount-injection";
import { parseDevcontainerConfigContent } from "../../../runtime/runtime-service/infra/local-devcontainer-jsonc";
import type { ProjectWorkLogger } from "../contracts/process-project-work-types";
import { logWork } from "../application/work-logger";
import { patchDevcontainerEnv } from "./local-project-runtime-environment-helpers";
import type { LocalProjectRuntimeEnvironmentDeps } from "./local-project-runtime-environment-deps";

const LOG_SCOPE = "git-credentials";

/**
 * Returns `null` when the worker has git credentials off, the repo has none
 * or opts out, or the devcontainer cannot take the relay (logged). Otherwise
 * opens the session and patches the devcontainer config; the session is
 * stopped before rethrowing if any patch fails.
 */
export async function prepareGitCredentialRelay(input: {
  deps: Pick<
    LocalProjectRuntimeEnvironmentDeps,
    "openGitCredentialRelaySession"
  >;
  repo: RepoConfig;
  sessionId: UuidV7;
  /** `taskRunId` is parsed as a UUID v7 only when a session opens. */
  runContext: Omit<GitCredentialRunContext, "taskRunId"> & {
    taskRunId: string;
  };
  workspacePath: string;
  devcontainerConfigPath: string;
  logger?: ProjectWorkLogger | undefined;
  onSecretValues?: ((values: readonly string[]) => void) | undefined;
}): Promise<GitCredentialRelaySession | null> {
  const open = input.deps.openGitCredentialRelaySession;
  if (
    open === null ||
    input.repo.mode === "none" ||
    input.repo.gitCredentials !== "auto"
  ) {
    return null;
  }

  const config = await readDevcontainerConfig(
    input.workspacePath,
    input.devcontainerConfigPath,
  );
  const skipReason = relaySkipReason(config);
  if (skipReason !== null) {
    const line = `Git credentials not offered to this container: ${skipReason}.`;
    logWork(LOG_SCOPE, line, { sessionId: input.sessionId });
    input.logger?.log(LOG_SCOPE, line);
    return null;
  }

  const session = await open({
    sessionId: input.sessionId,
    runContext: {
      ...input.runContext,
      taskRunId: parseUuidV7(input.runContext.taskRunId),
    },
    rewriteSshUrls: !("SSH_AUTH_SOCK" in config.containerEnv),
    logger: input.logger,
    onSecretValues: input.onSecretValues ?? (() => undefined),
  });
  try {
    await patchDevcontainerMounts(
      input.workspacePath,
      input.devcontainerConfigPath,
      [session.mount],
    );
    await patchDevcontainerRunArgs(
      input.workspacePath,
      input.devcontainerConfigPath,
      session.runArgs,
    );
    await patchDevcontainerEnv(
      input.workspacePath,
      input.devcontainerConfigPath,
      session.containerEnv,
    );
  } catch (error) {
    await session.stop();
    throw error;
  }
  logWork("runtime", "Patched devcontainer.json for git credential relay", {
    sessionId: input.sessionId,
    devcontainerConfigPath: input.devcontainerConfigPath,
  });
  return session;
}

type DevcontainerConfigView = {
  isCompose: boolean;
  containerEnv: Record<string, unknown>;
};

async function readDevcontainerConfig(
  workspacePath: string,
  devcontainerConfigPath: string,
): Promise<DevcontainerConfigView> {
  const raw = await readFile(
    path.join(workspacePath, devcontainerConfigPath),
    "utf8",
  );
  const parsed = parseDevcontainerConfigContent(raw) as Record<string, unknown>;
  const containerEnv = parsed["containerEnv"];
  return {
    isCompose: "dockerComposeFile" in parsed,
    containerEnv:
      containerEnv && typeof containerEnv === "object"
        ? (containerEnv as Record<string, unknown>)
        : {},
  };
}

function relaySkipReason(config: DevcontainerConfigView): string | null {
  if (config.isCompose) {
    return "compose-based devcontainers cannot take the helper mount";
  }
  if ("GIT_CONFIG_COUNT" in config.containerEnv) {
    return "containerEnv already sets GIT_CONFIG_COUNT";
  }
  return null;
}
