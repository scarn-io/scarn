import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { AnalyticsPort } from "@scarn/core/lib/analytics/analytics-port";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import { projectEntityToContract } from "./project-contract-mapper";
import type { ProjectRepo } from "./project-repo";
import { ProjectEntity } from "../domain/project-entity";
import { ProjectCreatedDomainEvent } from "../domain/project-created.domain-event";
import { deduplicateProjectSlug, slugify } from "../domain/project-slug";
import type { ProjectVisibility } from "../domain/project-visibility";
import {
  createProjectInputSchema,
  type CreateProjectInput,
  type ProjectContract,
  type ProjectCreationSource,
} from "../contracts/project-contracts";

export const createProject = async (
  input: CreateProjectInput & { source: ProjectCreationSource },
  {
    userAuthz,
    projectRepo,
    orgRepo,
    timeProvider,
    domainEventDispatcher,
    analytics,
    dbExecutor,
    // Never sourced from client input (`createProjectInputSchema` omits
    // `visibility` entirely) — only internal callers that already bypass the
    // HTTP contract (e.g. the demo-project seed script) pass this. Defaults
    // to "private", same as every project created through the API.
    visibility,
  }: {
    userAuthz: UserAuthorizationService;
    projectRepo: ProjectRepo;
    orgRepo: OrgRepo;
    timeProvider: TimeProvider;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    analytics: AnalyticsPort;
    dbExecutor?: DbExecutor | undefined;
    visibility?: ProjectVisibility | undefined;
  },
): Promise<ProjectContract> => {
  const parsedInput = createProjectInputSchema.parse(input);
  const runInTransaction = async (
    tx: DbTransaction,
  ): Promise<ProjectContract> => {
    const now = timeProvider.now();
    const projectId = createUuidV7();
    // Resolve the owning organization for tenancy/billing. We use the actor's
    // personal org as the owner. `createPersonalOrg` is idempotent (it keys on a
    // deterministic `personal-<userId>` slug and returns the existing org if
    // present), so calling it here guarantees every API-created project has an
    // owning org even when the better-auth signup hook never fired (e.g. older
    // accounts or tests that seed identity rows directly) without ever creating
    // duplicates. This is what makes usage metering — which resolves a project
    // to its org via `OrgRepo.findByProjectId` — trigger for new projects.
    const org = await orgRepo.createPersonalOrg(
      { ownerUserId: userAuthz.actorId, ownerName: null },
      tx,
    );
    // Derive a URL slug from the name, de-duped against slugs already taken in
    // the owning org so `unique(org_id, slug)` holds. The `unique` index is the
    // final backstop against a concurrent creation racing on the same slug.
    const existingSlugs = new Set(await projectRepo.listSlugsByOrg(org.id, tx));
    const slug = deduplicateProjectSlug(
      slugify(parsedInput.name),
      existingSlugs,
    );
    const project = ProjectEntity.create({
      id: projectId,
      name: parsedInput.name,
      slug,
      description: parsedInput.description,
      gitUrl: parsedInput.gitUrl,
      createdByUserId: userAuthz.actorId,
      orgId: org.id,
      memberships: [
        {
          projectId,
          userId: userAuthz.actorId,
          role: "admin",
          createdAt: now,
          updatedAt: now,
        },
      ],
      visibility,
      createdAt: now,
      updatedAt: now,
    });
    const createdProject = await projectRepo.create(project, tx);

    if (domainEventDispatcher) {
      await domainEventDispatcher.publish(
        [
          new ProjectCreatedDomainEvent(
            {
              projectId: createdProject.id,
              createdByUserId: createdProject.createdByUserId,
            },
            now,
          ),
        ],
        tx,
      );
    }

    return projectEntityToContract(createdProject);
  };

  const executor = dbExecutor ?? getDb();
  const created =
    "transaction" in executor
      ? await executor.transaction(async (tx) => await runInTransaction(tx))
      : await runInTransaction(executor);

  analytics.capture(created.createdByUserId, AnalyticsEvents.ProjectCreated, {
    project_id: created.id,
    source: input.source,
    origin: parsedInput.origin ?? "web",
  });

  return created;
};
