import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  deleteEnvironmentInputSchema,
  type DeleteEnvironmentInput,
  type DeleteEnvironmentResult,
} from "../contracts/environment-contracts";
import { EnvironmentInUseError } from "../domain/environment-in-use-error";
import type { EnvironmentRepo } from "./environment-repo";

/**
 * `DELETE /projects/:projectId/environments/:name`: soft-deletes the
 * environment. Refused with `EnvironmentInUseError` (409) while any
 * non-archived step definition names it. Its versions are kept, so
 * publishing the name again carries on the version numbers. Requires
 * `executions:write`.
 */
export const deleteEnvironment = async (
  input: DeleteEnvironmentInput,
  {
    userAuthz,
    environmentRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    environmentRepo: EnvironmentRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<DeleteEnvironmentResult, ResourceNotFoundError | EnvironmentInUseError>
> => {
  const { projectId, name } = deleteEnvironmentInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "settings:write",
  });

  const run = async (
    tx: DbExecutor,
  ): Promise<
    Result<
      DeleteEnvironmentResult,
      ResourceNotFoundError | EnvironmentInUseError
    >
  > => {
    const environment = await environmentRepo.findByName(projectId, name, tx);
    if (!environment || environment.isDeleted) {
      return Result.err(new ResourceNotFoundError("Environment", name));
    }
    const stepKeys = await environmentRepo.listActiveStepKeysUsing(
      projectId,
      name,
      tx,
    );
    if (stepKeys.length > 0) {
      return Result.err(new EnvironmentInUseError(name, stepKeys));
    }
    await environmentRepo.save(environment.delete(timeProvider.now()), tx);
    return Result.ok({ deleted: true });
  };

  return dbExecutor
    ? await dbExecutor.transaction(run)
    : await getDb().transaction(run);
};
