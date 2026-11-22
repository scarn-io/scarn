import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ManagedConnectionPresetContract } from "../contracts/managed-connection-contracts";
import {
  managedConnectionDefinitionOf,
  type ManagedConnectionPresets,
} from "./managed-connection-preset";
import { requireConnectionReader } from "./managed-connection-access";

/**
 * The presets a project's connections can be created from, with each
 * preset's normalized MCP URL and removal page. Requires project membership.
 */
export const listManagedConnectionPresets = async (
  input: { projectId: UuidV7 },
  deps: {
    userAuthz: UserAuthorizationService;
    managedConnectionPresets: ManagedConnectionPresets;
  },
): Promise<ManagedConnectionPresetContract[]> => {
  await requireConnectionReader(deps.userAuthz, input.projectId);
  return deps.managedConnectionPresets.list().map(({ key, preset }) => ({
    key,
    label: preset.label,
    resource: managedConnectionDefinitionOf(key, preset, key).server.resource,
    removalUrl: preset.removalUrl ?? null,
  }));
};
