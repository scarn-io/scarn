import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { StartManagedConnectionFromPresetInput } from "../contracts/managed-connection-contracts";
import {
  managedConnectionDefinitionOf,
  type ManagedConnectionPresets,
} from "./managed-connection-preset";
import { requireConnectionWriter } from "./managed-connection-access";
import type {
  ManagedOAuthStartBinding,
  StartManagedOAuthResponse,
} from "./open-managed-oauth-attempt";
import {
  startManagedConnection,
  type StartManagedConnectionDeps,
} from "./start-managed-connection";

type StartManagedConnectionFromPresetDeps = StartManagedConnectionDeps & {
  managedConnectionPresets: ManagedConnectionPresets;
};

/**
 * Starts connecting the project to preset `preset`'s server, as connection
 * `name` (the preset key when omitted). An unknown preset is
 * `MANAGED_CONNECTION_PRESET_UNKNOWN` (422); name and MCP URL collisions are
 * {@link startManagedConnection}'s. Requires `secrets:write`, checked before
 * the preset so a reader can't probe the catalog through this route.
 */
export const startManagedConnectionFromPreset = async <
  B extends ManagedOAuthStartBinding,
>(
  input: StartManagedConnectionFromPresetInput & {
    projectId: UuidV7;
    binding: B;
  },
  deps: StartManagedConnectionFromPresetDeps,
): Promise<StartManagedOAuthResponse<B>> => {
  await requireConnectionWriter(deps.userAuthz, input.projectId);
  const preset = deps.managedConnectionPresets.get(input.preset);
  if (!preset) {
    throw new CoreValidationError(
      `Unknown connection preset "${input.preset}"`,
      "MANAGED_CONNECTION_PRESET_UNKNOWN",
    );
  }
  return await startManagedConnection(
    {
      projectId: input.projectId,
      definition: managedConnectionDefinitionOf(
        input.preset,
        preset,
        input.name ?? input.preset,
      ),
      binding: input.binding,
    },
    deps,
  );
};
