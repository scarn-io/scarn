import { isSameGitRepo, parseGitHost } from "@scarn/sdk/git-url";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { GitHubInstallationRepo } from "@scarn/core/integrations/github-installation/application/github-installation-repo";
import {
  findCoveringGitHubInstallation,
  type ResolveInstallationRepo,
} from "@scarn/core/integrations/github-installation/application/find-covering-github-installation";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { ProjectRepo } from "./project-repo";
import { resolveProjectOwnerUsernames } from "./resolve-project-owner-usernames";
import {
  repoCheckInputSchema,
  type RepoCheckInput,
  type RepoCheckResponse,
} from "../contracts/project-setup-contracts";

export type CheckProjectRepoDeps = {
  projectRepo: ProjectRepo;
  githubInstallationRepo: GitHubInstallationRepo;
  orgRepo: OrgRepo;
  usernameReader: UsernameReader;
  /** Whether the GitHub App is configured; only then is `githubApp` looked up. */
  githubAppConfigured: boolean;
  /** Matches a renamed or transferred repo's old name to its installation. */
  resolveInstallationRepo?: ResolveInstallationRepo | undefined;
};

const lastPathSegment = (gitUrl: string): string => {
  const trimmed = gitUrl.trim().replace(/[/\\]+$/u, "");
  const segment = trimmed.split(/[/\\:]/u).pop() ?? "";
  return segment.replace(/\.git$/iu, "");
};

const defaultNameFor = (gitUrl: string): string => {
  const host = parseGitHost(gitUrl);
  switch (host.host) {
    case "github":
      return host.name;
    case "bitbucket":
      return host.slug;
    case "other":
      return lastPathSegment(gitUrl) || "project";
  }
};

/**
 * Looks at a repo URL before a project is created: which host it is on, a
 * default project name, which of the caller's projects already uses it (if
 * any), and (for GitHub, when the App is configured) the caller's App
 * installation that covers it. Reads only.
 */
export const checkProjectRepo = async (
  input: RepoCheckInput & { userId: UuidV7 },
  deps: CheckProjectRepoDeps,
): Promise<RepoCheckResponse> => {
  const { gitUrl } = repoCheckInputSchema.parse(input);
  const host = parseGitHost(gitUrl);

  const projects = await deps.projectRepo.listByUser(input.userId);
  const existing = projects.find((project) =>
    isSameGitRepo(project.gitUrl, gitUrl),
  );
  const ownerUsernames = existing
    ? await resolveProjectOwnerUsernames([existing], deps)
    : null;

  const response: RepoCheckResponse = {
    host: host.host,
    webUrl: host.host === "other" ? null : host.webUrl,
    defaultName: defaultNameFor(gitUrl),
    alreadyExists: existing !== undefined,
    existingProject: existing
      ? {
          name: existing.name,
          slug: existing.slug,
          ownerUsername: ownerUsernames?.get(existing.id) ?? null,
        }
      : null,
  };

  if (host.host !== "github" || !deps.githubAppConfigured) {
    return response;
  }
  const covering = await findCoveringGitHubInstallation(
    { userId: input.userId, owner: host.owner, name: host.name },
    deps,
  );
  return {
    ...response,
    githubApp: covering
      ? {
          installationId: covering.installationId,
          accountLogin: covering.accountLogin,
        }
      : null,
  };
};
