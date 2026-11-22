import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  publishEnvironmentVersionInputSchema,
  type PublishEnvironmentVersionInput,
  type PublishEnvironmentVersionResult,
} from "../contracts/environment-contracts";
import { EnvironmentEntity } from "../domain/environment-entity";
import {
  EnvironmentVersionEntity,
  hashEnvironmentContent,
  normalizeEnvironmentContent,
} from "../domain/environment-version-entity";
import { environmentNameSchema } from "@scarn/core/common/contracts/environment";
import { CoreValidationError, PersistenceError } from "@scarn/core/lib/errors";
import type { EnvironmentRepo } from "./environment-repo";
import {
  type EnvironmentContractMapperDeps,
  environmentWithVersionToContract,
} from "./environment-contract-mapper";

export type PublishEnvironmentVersionDeps = EnvironmentContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  environmentRepo: EnvironmentRepo;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * `PUT /projects/:projectId/environments/:name`: stores `content` as the
 * environment's next version, creating the environment when the project has
 * none by that name and restoring it when it was deleted. When the content
 * hash matches the latest version, no version is added (`published: false`).
 * Requires `executions:write`. An invalid name or content throws
 * `CoreValidationError` (`ENVIRONMENT_NAME_INVALID` /
 * `ENVIRONMENT_CONTENT_INVALID`, 422).
 */
export const publishEnvironmentVersion = async (
  input: PublishEnvironmentVersionInput,
  {
    userAuthz,
    environmentRepo,
    timeProvider,
    dbExecutor,
    ...deps
  }: PublishEnvironmentVersionDeps,
): Promise<PublishEnvironmentVersionResult> => {
  const { projectId } = publishEnvironmentVersionInputSchema
    .pick({ projectId: true })
    .parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "settings:write",
  });
  const name = environmentNameSchema.safeParse(input.name);
  if (!name.success) {
    throw new CoreValidationError(
      `Environment name "${input.name}" must match /^[a-z0-9][a-z0-9-]*$/`,
      "ENVIRONMENT_NAME_INVALID",
    );
  }
  const parsed = { projectId, name: name.data };
  const content = normalizeEnvironmentContent(input.content);
  const contentHash = hashEnvironmentContent(content);

  const run = async (
    tx: DbExecutor,
  ): Promise<PublishEnvironmentVersionResult> => {
    const now = timeProvider.now();
    const locked = await environmentRepo.lockOrCreate(
      EnvironmentEntity.create({
        projectId: parsed.projectId,
        name: parsed.name,
        now,
      }),
      tx,
    );
    const latest =
      locked.latestVersion > 0
        ? await environmentRepo.loadVersion(locked.id, locked.latestVersion, tx)
        : null;
    if (locked.latestVersion > 0 && latest === null) {
      throw new PersistenceError(
        `Environment ${locked.id} is missing its latest version ${String(locked.latestVersion)}`,
        "ENVIRONMENT_LATEST_VERSION_MISSING",
      );
    }

    if (latest?.contentHash === contentHash) {
      const environment = locked.isDeleted
        ? await environmentRepo.save(locked.restore(now), tx)
        : locked;
      return {
        published: false,
        ...(await environmentWithVersionToContract(
          { environment, version: latest },
          latest,
          deps,
          tx,
        )),
      };
    }

    const version = await environmentRepo.insertVersion(
      EnvironmentVersionEntity.create({
        environmentId: locked.id,
        version: locked.nextVersion,
        content,
        createdByUserId: userAuthz.actorId,
        createdAt: now,
      }),
      tx,
    );
    const environment = await environmentRepo.save(
      locked.publishVersion(version.version, now),
      tx,
    );
    return {
      published: true,
      ...(await environmentWithVersionToContract(
        { environment, version },
        version,
        deps,
        tx,
      )),
    };
  };

  return dbExecutor
    ? await dbExecutor.transaction(run)
    : await getDb().transaction(run);
};
