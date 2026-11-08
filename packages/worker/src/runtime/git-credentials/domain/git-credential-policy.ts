import { normaliseGitUrl } from "../../runtime-service/domain/git-mirror-key";
import type { GitCredentialQuery } from "./git-credential-protocol";

/**
 * Which credential requests the relay may answer for one Task run: HTTPS only,
 * and only for an allowed host.
 *
 * The Task repo's own host is always allowed. It is derived through
 * `normaliseGitUrl`, so an SSH or SCP-style repo URL still allows its host
 * over HTTPS. An `https` repo URL keeps its port; any other scheme's port
 * (an SSH port, say) means nothing over HTTPS and is dropped. Hosts are
 * compared lowercased and a port must match exactly (`host:port` in git's
 * `host` attribute). Any path on an allowed host is accepted.
 */

export type GitCredentialDenialReason = "protocol" | "host";

export type GitCredentialDecision =
  { allowed: true } | { allowed: false; reason: GitCredentialDenialReason };

const NORMALISED_AUTHORITY = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/;

export class GitCredentialPolicy {
  readonly allowedHosts: readonly string[];

  private constructor(allowedHosts: readonly string[]) {
    this.allowedHosts = allowedHosts;
  }

  static forRepo(input: {
    repoGitUrl: string;
    extraHosts: readonly string[];
  }): GitCredentialPolicy {
    const hosts = new Set<string>();
    const repoHost = httpsHostOf(input.repoGitUrl);
    if (repoHost) {
      hosts.add(repoHost);
    }
    for (const host of input.extraHosts) {
      const normalised = host.trim().toLowerCase();
      if (normalised) {
        hosts.add(normalised);
      }
    }
    return new GitCredentialPolicy([...hosts]);
  }

  evaluate(query: GitCredentialQuery): GitCredentialDecision {
    if (query.protocol.toLowerCase() !== "https") {
      return { allowed: false, reason: "protocol" };
    }
    if (!this.allowedHosts.includes(query.host.trim().toLowerCase())) {
      return { allowed: false, reason: "host" };
    }
    return { allowed: true };
  }
}

function httpsHostOf(repoGitUrl: string): string | null {
  const normalised = normaliseGitUrl(repoGitUrl);
  const match =
    normalised === null ? null : NORMALISED_AUTHORITY.exec(normalised);
  if (!match) {
    return null;
  }
  const [, scheme = "", authority = ""] = match;
  if (authority === "") {
    return null;
  }
  return scheme === "https" ? authority : stripPort(authority);
}

function stripPort(authority: string): string {
  return authority.replace(/:\d*$/, "");
}
