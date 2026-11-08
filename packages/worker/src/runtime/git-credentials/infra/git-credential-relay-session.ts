import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UuidV7 } from "../../../common/contracts/uuid-v7";
import {
  HOST_GATEWAY_RUN_ARGS,
  type DevcontainerBindMount,
} from "../../runtime-service/infra/devcontainer-mount-injection";
import { logWork } from "../../../work/task-run/application/work-logger";
import type { ProjectWorkLogger } from "../../../work/task-run/contracts/process-project-work-types";
import {
  CredentialRelay,
  type GitCredentialAuditEntry,
} from "../application/credential-relay";
import type {
  GitCredentialRunContext,
  GitCredentialSourceFactory,
} from "../application/git-credential-source";
import {
  buildGitCredentialContainerEnv,
  CONTAINER_GIT_CREDENTIAL_DIR,
  CONTAINER_GIT_CREDENTIAL_HELPER_PATH,
  GIT_CREDENTIAL_HELPER_FILENAME,
} from "../domain/git-credential-container-env";
import {
  buildGitCredentialHelperScript,
  GIT_CREDENTIAL_ENDPOINT_FILENAME,
  GIT_CREDENTIAL_TOKEN_FILENAME,
} from "../domain/git-credential-helper-script";
import { GitCredentialPolicy } from "../domain/git-credential-policy";
import { CredentialRelayServer } from "./credential-relay-server";
import type { GitCredentialRelayConfig } from "./git-credential-relay-config";

/**
 * One git credential relay session per Task run (decision 4): its own server,
 * port, 32-byte bearer token and helper dir. The helper dir
 * (`<baseDir>/<sessionId>/`) holds `git-credential-scarn`, `endpoint` and
 * `token`, and is bind-mounted read-only at
 * {@link CONTAINER_GIT_CREDENTIAL_DIR}.
 */

const LOG_SCOPE = "git-credentials";
const DEFAULT_ENDPOINT_HOST = "host.docker.internal";
const TOKEN_BYTES = 32;

export type GitCredentialRelaySession = {
  /** Bind-mount for `patchDevcontainerMounts`. */
  mount: DevcontainerBindMount;
  /** Merged into `containerEnv` (decision 5). */
  containerEnv: Record<string, string>;
  /** `HOST_GATEWAY_RUN_ARGS`, so Linux resolves `host.docker.internal`. */
  runArgs: readonly string[];
  stop(): Promise<void>;
};

export type OpenGitCredentialRelaySessionInput = {
  sessionId: UuidV7;
  runContext: GitCredentialRunContext;
  /** Rewrite SSH URLs on allowed hosts to HTTPS; off when the container has its own SSH agent. */
  rewriteSshUrls: boolean;
  logger?: ProjectWorkLogger | undefined;
  onSecretValues: (values: readonly string[]) => void;
};

export type OpenGitCredentialRelaySession = (
  input: OpenGitCredentialRelaySessionInput,
) => Promise<GitCredentialRelaySession>;

export type GitCredentialRelaySessionOpenerOptions = {
  config: GitCredentialRelayConfig;
  sourceFactory: GitCredentialSourceFactory;
  /** Parent of the per-session helper dirs. Defaults to `os.tmpdir()/scarn-git-credential`. */
  baseDir?: string | undefined;
  /** Host written into `endpoint`. Defaults to `host.docker.internal`. */
  endpointHost?: string | undefined;
};

export function createGitCredentialRelaySessionOpener(
  options: GitCredentialRelaySessionOpenerOptions,
): OpenGitCredentialRelaySession {
  const baseDir =
    options.baseDir ?? path.join(os.tmpdir(), "scarn-git-credential");
  const endpointHost = options.endpointHost ?? DEFAULT_ENDPOINT_HOST;

  return async (input) => {
    const policy = GitCredentialPolicy.forRepo({
      repoGitUrl: input.runContext.repoGitUrl,
      extraHosts: options.config.extraHosts,
    });
    const relay = new CredentialRelay({
      policy,
      source: options.sourceFactory(input.runContext),
      audit: (entry) => {
        audit(entry, input.logger);
      },
      onSecretValues: input.onSecretValues,
    });
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const server = new CredentialRelayServer({
      relay,
      token,
      bindAddress: options.config.bindAddress,
    });
    const dir = path.join(baseDir, input.sessionId);

    let stopping: Promise<void> | null = null;
    const stop = (): Promise<void> => {
      stopping ??= Promise.all([
        server.stop(),
        rm(dir, { recursive: true, force: true }),
      ]).then(() => undefined);
      return stopping;
    };

    try {
      const port = await server.start();
      await writeHelperDir(dir, {
        endpoint: `http://${endpointHost}:${String(port)}`,
        token,
      });
      logWork(LOG_SCOPE, "Git credential relay session started", {
        sessionId: input.sessionId,
        port,
        allowedHosts: policy.allowedHosts,
      });
    } catch (error) {
      await stop();
      throw error;
    }

    return {
      mount: {
        source: dir,
        target: CONTAINER_GIT_CREDENTIAL_DIR,
        readOnly: true,
      },
      containerEnv: buildGitCredentialContainerEnv({
        helperPath: CONTAINER_GIT_CREDENTIAL_HELPER_PATH,
        allowedHosts: policy.allowedHosts,
        rewriteSshUrls: input.rewriteSshUrls,
      }),
      runArgs: HOST_GATEWAY_RUN_ARGS,
      stop,
    };
  };
}

async function writeHelperDir(
  dir: string,
  contents: { endpoint: string; token: string },
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await chmod(dir, 0o755);
  const files: [string, string, number][] = [
    [GIT_CREDENTIAL_HELPER_FILENAME, buildGitCredentialHelperScript(), 0o755],
    [GIT_CREDENTIAL_ENDPOINT_FILENAME, `${contents.endpoint}\n`, 0o644],
    [GIT_CREDENTIAL_TOKEN_FILENAME, `${contents.token}\n`, 0o644],
  ];
  for (const [name, content, mode] of files) {
    const filePath = path.join(dir, name);
    await writeFile(filePath, content, { mode });
    await chmod(filePath, mode);
  }
}

/** `git credential get github.com/org/repo: issued (host)`. */
export function formatGitCredentialAuditLine(
  entry: GitCredentialAuditEntry,
): string {
  const scheme =
    entry.protocol !== null && entry.protocol !== "https"
      ? `${entry.protocol}://`
      : "";
  const target =
    entry.host === null
      ? "<unparsed request>"
      : `${scheme}${entry.host}${entry.path ? `/${entry.path}` : ""}`;
  const reason = entry.reason ? ` [${entry.reason}]` : "";
  return `git credential ${entry.operation} ${target}: ${entry.outcome}${reason} (${entry.source})`;
}

function audit(
  entry: GitCredentialAuditEntry,
  logger: ProjectWorkLogger | undefined,
): void {
  const line = formatGitCredentialAuditLine(entry);
  logWork(LOG_SCOPE, line, { ...entry });
  logger?.log(LOG_SCOPE, line);
}
