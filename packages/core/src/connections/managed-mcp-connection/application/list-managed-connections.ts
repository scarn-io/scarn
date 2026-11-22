import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ManagedConnectionContract } from "../contracts/managed-connection-contracts";
import { requireConnectionReader } from "./managed-connection-access";
import {
  managedConnectionToContract,
  type ManagedConnectionContractMapperDeps,
} from "./managed-connection-contract-mapper";
import type { ManagedConnectionRepo } from "./managed-connection-repo";

type ListManagedConnectionsDeps = ManagedConnectionContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  managedConnectionRepo: ManagedConnectionRepo;
  timeProvider: TimeProvider;
};

/**
 * The project's managed connections (at most one per provider), with lapsed
 * connects and candidates shown as expired. Requires membership.
 */
export const listManagedConnections = async (
  input: { projectId: UuidV7 },
  deps: ListManagedConnectionsDeps,
): Promise<ManagedConnectionContract[]> => {
  await requireConnectionReader(deps.userAuthz, input.projectId);
  const connections = await deps.managedConnectionRepo.listByProject(
    input.projectId,
  );
  const now = deps.timeProvider.now();
  return await Promise.all(
    connections.map((connection) =>
      managedConnectionToContract(connection, deps, undefined, now),
    ),
  );
};
