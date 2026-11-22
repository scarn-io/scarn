import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ManagedConnectionContract } from "../contracts/managed-connection-contracts";
import {
  managedConnectionNotFound,
  requireConnectionReader,
} from "./managed-connection-access";
import {
  managedConnectionToContract,
  type ManagedConnectionContractMapperDeps,
} from "./managed-connection-contract-mapper";
import type { ManagedConnectionRepo } from "./managed-connection-repo";

type GetManagedConnectionDeps = ManagedConnectionContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  managedConnectionRepo: ManagedConnectionRepo;
  timeProvider: TimeProvider;
};

/**
 * One managed connection, including a pending candidate's account and scopes
 * for the person deciding whether to confirm it. A connect or candidate that
 * has lapsed is shown as expired even before the sweep writes it. Requires
 * membership.
 */
export const getManagedConnection = async (
  input: { projectId: UuidV7; connectionId: UuidV7 },
  deps: GetManagedConnectionDeps,
): Promise<ManagedConnectionContract> => {
  await requireConnectionReader(deps.userAuthz, input.projectId);
  const connection = await deps.managedConnectionRepo.findById(
    input.projectId,
    input.connectionId,
  );
  if (!connection) {
    throw managedConnectionNotFound(input.connectionId);
  }
  return await managedConnectionToContract(
    connection,
    deps,
    undefined,
    deps.timeProvider.now(),
  );
};
