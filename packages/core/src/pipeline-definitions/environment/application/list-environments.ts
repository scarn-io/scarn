import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  listEnvironmentsInputSchema,
  type EnvironmentContract,
  type ListEnvironmentsInput,
} from "../contracts/environment-contracts";
import type { EnvironmentRepo } from "./environment-repo";
import {
  type EnvironmentContractMapperDeps,
  environmentsToContracts,
} from "./environment-contract-mapper";

/**
 * `GET /projects/:projectId/environments`: the project's environments that
 * aren't deleted, by name, each with its latest version's description and
 * who published it when. Requires `executions:read`.
 */
export const listEnvironments = async (
  input: ListEnvironmentsInput,
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
): Promise<EnvironmentContract[]> => {
  const { projectId } = listEnvironmentsInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
  });
  const rows = await environmentRepo.listLiveWithLatestVersion(
    projectId,
    dbExecutor,
  );
  return await environmentsToContracts(rows, deps, dbExecutor);
};
