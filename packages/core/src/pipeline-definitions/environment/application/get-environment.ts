import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  PersistenceError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getEnvironmentInputSchema,
  type EnvironmentWithVersionContract,
  type GetEnvironmentInput,
} from "../contracts/environment-contracts";
import type { EnvironmentRepo } from "./environment-repo";
import {
  type EnvironmentContractMapperDeps,
  environmentWithVersionToContract,
} from "./environment-contract-mapper";

/**
 * `GET /projects/:projectId/environments/:name[?version=N]`: the
 * environment with its latest version, or version `N`. A deleted
 * environment, or a version it doesn't have, is not found. Requires
 * `executions:read`.
 */
export const getEnvironment = async (
  input: GetEnvironmentInput,
  {
    userAuthz,
    environmentRepo,
    dbExecutor,
    ...deps
  }: EnvironmentContractMapperDeps & {
    userAuthz: UserAuthorizationService;
    environmentRepo: EnvironmentRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<EnvironmentWithVersionContract, ResourceNotFoundError>> => {
  const parsed = getEnvironmentInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId: parsed.projectId,
    permission: "executions:read",
  });
  const environment = await environmentRepo.findByName(
    parsed.projectId,
    parsed.name,
    dbExecutor,
  );
  if (!environment || environment.isDeleted) {
    return Result.err(new ResourceNotFoundError("Environment", parsed.name));
  }

  const latest = await environmentRepo.loadVersion(
    environment.id,
    environment.latestVersion,
    dbExecutor,
  );
  if (!latest) {
    throw new PersistenceError(
      `Environment ${environment.id} is missing its latest version ${String(environment.latestVersion)}`,
      "ENVIRONMENT_LATEST_VERSION_MISSING",
    );
  }
  const version =
    parsed.version === undefined || parsed.version === latest.version
      ? latest
      : await environmentRepo.loadVersion(
          environment.id,
          parsed.version,
          dbExecutor,
        );
  if (!version) {
    return Result.err(
      new ResourceNotFoundError(
        "Environment version",
        `${parsed.name}@${String(parsed.version)}`,
      ),
    );
  }

  return Result.ok(
    await environmentWithVersionToContract(
      { environment, version },
      latest,
      deps,
      dbExecutor,
    ),
  );
};
