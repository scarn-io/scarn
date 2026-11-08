import { ConfigurationError } from "../../../lib/errors";
import type { GitCredentialSourceMode } from "../application/git-credential-source";

type Env = Record<string, string | undefined>;

export type GitCredentialRelayConfig = {
  /** Whether this worker offers git credentials to containers at all. */
  enabled: boolean;
  sourceMode: GitCredentialSourceMode;
  extraHosts: readonly string[];
  bindAddress: string;
};

/**
 * Resolves the git credential relay configuration from environment variables.
 *
 *   - `SCARN_GIT_CREDENTIALS` is `on` or `off` (case-insensitive, trimmed).
 *     Unset or blank means `on`. The worker owner's consent: with `off` no
 *     relay is opened and the other settings are not validated. Anything else
 *     is `GIT_CREDENTIALS_INVALID`.
 *   - `SCARN_GIT_CREDENTIAL_SOURCE` is `host` or `api` (case-insensitive,
 *     trimmed). Unset or blank means `host`. `api` is a declared seam that
 *     throws {@link ApiGitCredentialSourceNotImplementedError} until it is
 *     built. Anything else is `GIT_CREDENTIAL_SOURCE_INVALID`.
 *   - `SCARN_GIT_CREDENTIAL_HOSTS` is a comma-separated list of extra
 *     `host[:port]` entries the relay may answer for, lowercased. Blank
 *     entries are skipped; a scheme, path, userinfo or whitespace inside an
 *     entry is `GIT_CREDENTIAL_HOSTS_INVALID`.
 *   - `SCARN_GIT_CREDENTIAL_RELAY_BIND` is the address the relay server binds.
 *     Unset or blank means `127.0.0.1` on macOS and Windows (Docker Desktop
 *     forwards `host.docker.internal` to it) and `0.0.0.0` on Linux.
 */
export function resolveGitCredentialRelayConfig(
  env: Env,
  platform: NodeJS.Platform = process.platform,
): GitCredentialRelayConfig {
  const bindAddress = resolveBindAddress(env, platform);
  if (!resolveEnabled(env)) {
    return { enabled: false, sourceMode: "host", extraHosts: [], bindAddress };
  }
  return {
    enabled: true,
    sourceMode: resolveSourceMode(env),
    extraHosts: resolveExtraHosts(env),
    bindAddress,
  };
}

/**
 * Thrown if the `api` source is selected. It is a declared seam only; the
 * API-minted token source is not implemented yet.
 */
export class ApiGitCredentialSourceNotImplementedError extends Error {
  constructor() {
    super(
      "The 'api' git credential source is a declared seam and is not implemented yet.",
    );
    this.name = "ApiGitCredentialSourceNotImplementedError";
  }
}

const HOST_ENTRY =
  /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d+)?$/;

function resolveEnabled(env: Env): boolean {
  const raw = env["SCARN_GIT_CREDENTIALS"]?.trim().toLowerCase();
  if (!raw || raw === "on") {
    return true;
  }
  if (raw === "off") {
    return false;
  }
  throw new ConfigurationError(
    `Unknown SCARN_GIT_CREDENTIALS value '${raw}'. Valid values are 'on' and 'off'.`,
    "GIT_CREDENTIALS_INVALID",
  );
}

function resolveSourceMode(env: Env): GitCredentialSourceMode {
  const raw = env["SCARN_GIT_CREDENTIAL_SOURCE"]?.trim().toLowerCase();
  if (!raw || raw === "host") {
    return "host";
  }
  if (raw === "api") {
    throw new ApiGitCredentialSourceNotImplementedError();
  }
  throw new ConfigurationError(
    `Unknown SCARN_GIT_CREDENTIAL_SOURCE value '${raw}'. Valid values are 'host' and 'api'.`,
    "GIT_CREDENTIAL_SOURCE_INVALID",
  );
}

function resolveExtraHosts(env: Env): string[] {
  const raw = env["SCARN_GIT_CREDENTIAL_HOSTS"];
  if (!raw?.trim()) {
    return [];
  }
  const hosts: string[] = [];
  for (const entry of raw.split(",")) {
    const host = entry.trim().toLowerCase();
    if (host === "") {
      continue;
    }
    if (!HOST_ENTRY.test(host)) {
      throw new ConfigurationError(
        `SCARN_GIT_CREDENTIAL_HOSTS entry '${host}' is not a host or host:port.`,
        "GIT_CREDENTIAL_HOSTS_INVALID",
      );
    }
    if (!hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
}

function resolveBindAddress(env: Env, platform: NodeJS.Platform): string {
  const configured = env["SCARN_GIT_CREDENTIAL_RELAY_BIND"]?.trim();
  if (configured) {
    return configured;
  }
  return platform === "linux" ? "0.0.0.0" : "127.0.0.1";
}
