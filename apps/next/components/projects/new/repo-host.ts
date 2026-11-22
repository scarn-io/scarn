import { parseGitHost, type GitHost } from "@scarn/sdk/git-url";
import type { RepoCheckResponse } from "@scarn/core/projects/project/contracts/project-setup-contracts";

export type RepoCheck = RepoCheckResponse;

/** "GitHub · acme/api", "Bitbucket · team/api" or "Other git host". */
export function hostLabel(host: GitHost): string {
  switch (host.host) {
    case "github":
      return `GitHub · ${host.owner}/${host.name}`;
    case "bitbucket":
      return `Bitbucket · ${host.workspace}/${host.slug}`;
    case "other":
      return "Other git host";
  }
}

/** The host chip label for a typed URL, or null while the field is empty. */
export function hostChipLabel(gitUrl: string): string | null {
  const trimmed = gitUrl.trim();
  return trimmed ? hostLabel(parseGitHost(trimmed)) : null;
}

/** "acme" for a GitHub URL, else undefined. */
export function githubOwner(gitUrl: string): string | undefined {
  const trimmed = gitUrl.trim();
  if (!trimmed) return undefined;
  const host = parseGitHost(trimmed);
  return host.host === "github" ? host.owner : undefined;
}

/** "acme/api" for a GitHub or Bitbucket URL, else null. */
export function repoFullName(host: GitHost): string | null {
  switch (host.host) {
    case "github":
      return `${host.owner}/${host.name}`;
    case "bitbucket":
      return `${host.workspace}/${host.slug}`;
    case "other":
      return null;
  }
}
