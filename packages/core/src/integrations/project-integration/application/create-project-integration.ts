import { CoreValidationError } from "@scarn/core/lib/errors";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  ProjectIntegrationEntity,
  type BitbucketProjectIntegrationScope,
  type GitHubProjectIntegrationScope,
  type JiraProjectIntegrationScope,
} from "../domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

type CreateProjectIntegrationCommonInput = {
  projectId: UuidV7;
  firstSyncHorizonDays?: number | null | undefined;
};

export type CreateProjectIntegrationInput =
  | (CreateProjectIntegrationCommonInput & {
      kind: "github_app";
      installationId: string;
      externalScope: GitHubProjectIntegrationScope;
    })
  | (CreateProjectIntegrationCommonInput & {
      kind: "github_token";
      externalScope: GitHubProjectIntegrationScope;
    })
  | (CreateProjectIntegrationCommonInput & {
      kind: "bitbucket";
      externalScope: BitbucketProjectIntegrationScope;
    })
  | (CreateProjectIntegrationCommonInput & {
      kind: "jira";
      externalScope: JiraProjectIntegrationScope;
    });

const toEntity = (
  input: CreateProjectIntegrationInput,
): ProjectIntegrationEntity => {
  const common = {
    projectId: input.projectId,
    firstSyncHorizonDays: input.firstSyncHorizonDays ?? null,
  };
  switch (input.kind) {
    case "github_app":
      return ProjectIntegrationEntity.create({
        ...common,
        kind: input.kind,
        installationId: input.installationId,
        scope: input.externalScope,
      });
    case "github_token":
      return ProjectIntegrationEntity.create({
        ...common,
        kind: input.kind,
        scope: input.externalScope,
      });
    case "bitbucket":
      return ProjectIntegrationEntity.create({
        ...common,
        kind: input.kind,
        scope: input.externalScope,
      });
    case "jira":
      return ProjectIntegrationEntity.create({
        ...common,
        kind: input.kind,
        scope: input.externalScope,
      });
    default:
      return assertNever(input);
  }
};

/**
 * Two integrations of the same kind on one project overlap when they would
 * read the same source: the same App installation, a shared repository (by full name), or
 * the same Jira site. Different kinds never overlap.
 */
type RepoScoped = { scope: { repos: readonly { fullName: string }[] } };

const sharesRepo = (existing: RepoScoped, candidate: RepoScoped): boolean => {
  const existingRepos = new Set(
    existing.scope.repos.map((repo) => repo.fullName.toLowerCase()),
  );
  return candidate.scope.repos.some((repo) =>
    existingRepos.has(repo.fullName.toLowerCase()),
  );
};

const overlaps = (
  existing: ProjectIntegrationEntity,
  candidate: ProjectIntegrationEntity,
): boolean => {
  switch (candidate.kind) {
    case "github_app":
      if (existing.kind !== candidate.kind) return false;
      return (
        existing.installationId === candidate.installationId ||
        sharesRepo(existing, candidate)
      );
    case "github_token":
      return (
        existing.kind === candidate.kind && sharesRepo(existing, candidate)
      );
    case "bitbucket":
      return (
        existing.kind === candidate.kind && sharesRepo(existing, candidate)
      );
    case "jira":
      return (
        existing.kind === candidate.kind &&
        existing.scope.baseUrl === candidate.scope.baseUrl
      );
    default:
      return assertNever(candidate);
  }
};

export const createProjectIntegration = async (
  input: CreateProjectIntegrationInput,
  repo: ProjectIntegrationRepo,
): Promise<ProjectIntegrationEntity> => {
  const entity = toEntity(input);
  const existing = await repo.listByProjectId(input.projectId);
  if (existing.some((entry) => overlaps(entry, entity))) {
    throw new CoreValidationError(
      `An overlapping ${entity.kind} integration already exists on this project`,
      "PROJECT_INTEGRATION_DUPLICATE",
    );
  }
  return repo.create(entity);
};
