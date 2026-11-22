import { normalizeMcpResourceUrl } from "@scarn/sdk/managed-connections";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type {
  CustomManagedConnectionInput,
  ManagedMcpServerProbeContract,
  ProbeManagedMcpServerInput,
} from "../contracts/custom-managed-connection-contracts";
import { parseLoopbackRedirectUri } from "../domain/loopback-redirect";
import { managedDiscoveryOverridesOf } from "../domain/managed-connection-discovery";
import type {
  ManagedConnectionDefinition,
  ManagedConnectionServer,
} from "../domain/managed-connection-server";
import { requireConnectionWriter } from "./managed-connection-access";
import {
  managedConnectionResourceInvalid,
  ManagedConnectionIssuerChangedError,
  type ManagedMcpServerProbe,
  type ManagedMcpServerProber,
} from "./managed-mcp-server-prober";
import type {
  ManagedOAuthStartBinding,
  StartManagedOAuthResponse,
} from "./open-managed-oauth-attempt";
import {
  startManagedConnection,
  type StartManagedConnectionDeps,
} from "./start-managed-connection";

/**
 * Custom MCP servers (decision 12): probing a URL from the user's MCP config,
 * and creating its connection once the user has confirmed the issuer the
 * probe found. Nothing is stored until the start, and the start probes again
 * and stores the discovery overrides that probe found with the connection.
 */

type ProbeCustomManagedConnectionDeps = {
  userAuthz: UserAuthorizationService;
  managedMcpServerProber: ManagedMcpServerProber;
};

type StartCustomManagedConnectionDeps = StartManagedConnectionDeps &
  ProbeCustomManagedConnectionDeps;

type SuppliedClient = NonNullable<ProbeManagedMcpServerInput["client"]>;

const managedConnectionClientRequired = () =>
  new CoreValidationError(
    "This server needs a client ID in your MCP config: it supports neither client ID metadata documents nor dynamic client registration.",
    "MANAGED_CONNECTION_CLIENT_REQUIRED",
  );

const normalizedResource = (resource: string): string => {
  const normalized = normalizeMcpResourceUrl(resource);
  if (normalized === null) {
    throw managedConnectionResourceInvalid(
      "it must be an absolute https URL without a query, fragment or credentials",
    );
  }
  return normalized;
};

const checkedClient = (
  client: SuppliedClient | undefined,
): SuppliedClient | null =>
  client === undefined
    ? null
    : {
        clientId: client.clientId,
        redirectUri: parseLoopbackRedirectUri(client.redirectUri),
      };

/** How Scarn signs in to the probed server, given the user's client, if any. */
const serverOf = (
  probe: ManagedMcpServerProbe,
  client: SuppliedClient | null,
): ManagedConnectionServer => {
  const base = {
    resource: probe.resource,
    issuerOrigin: probe.issuerOrigin,
    ...(managedDiscoveryOverridesOf(probe.discovery).length === 0
      ? {}
      : { discovery: probe.discovery }),
  };
  if (client !== null) {
    return {
      ...base,
      clientRegistration: "supplied",
      suppliedClientId: client.clientId,
      suppliedRedirectUri: client.redirectUri,
    };
  }
  if (probe.supports.cimd) {
    return { ...base, clientRegistration: "cimd" };
  }
  if (probe.supports.dcr) {
    return { ...base, clientRegistration: "dcr" };
  }
  throw managedConnectionClientRequired();
};

const probeCustomServer = async (
  input: { resource: string; client?: SuppliedClient | undefined },
  deps: ProbeCustomManagedConnectionDeps,
) => {
  const resource = normalizedResource(input.resource);
  const client = checkedClient(input.client);
  const probe = await deps.managedMcpServerProber.probe(resource, {
    clientSupplied: client !== null,
  });
  return { probe, server: serverOf(probe, client) };
};

/**
 * Probes `resource` for the CLI to show before the user confirms its
 * issuer. A server Scarn can't register with and no supplied client is 422
 * `MANAGED_CONNECTION_CLIENT_REQUIRED`; the probe's own failures are
 * {@link ManagedMcpServerProber}'s. Requires `secrets:write`.
 */
export const probeCustomManagedConnection = async (
  input: ProbeManagedMcpServerInput & { projectId: UuidV7 },
  deps: ProbeCustomManagedConnectionDeps,
): Promise<ManagedMcpServerProbeContract> => {
  await requireConnectionWriter(deps.userAuthz, input.projectId);
  const { probe, server } = await probeCustomServer(input, deps);
  return {
    resource: probe.resource,
    issuerOrigin: probe.issuerOrigin,
    endpointOrigins: probe.endpointOrigins,
    clientRegistration: server.clientRegistration,
    supports: probe.supports,
    overrides: probe.discovery,
  };
};

/**
 * Starts connecting the project to a custom server as connection `name`,
 * probing it again first. When the issuer origin found now isn't
 * `confirmIssuerOrigin` it is 409 `MANAGED_CONNECTION_ISSUER_CHANGED` and
 * nothing is stored. Otherwise as {@link startManagedConnection}, with no
 * preset: a same-named custom connection is restarted on its stored server,
 * scopes included. Requires `secrets:write`.
 */
export const startCustomManagedConnection = async <
  B extends ManagedOAuthStartBinding,
>(
  input: {
    projectId: UuidV7;
    custom: CustomManagedConnectionInput;
    binding: B;
  },
  deps: StartCustomManagedConnectionDeps,
): Promise<StartManagedOAuthResponse<B>> => {
  await requireConnectionWriter(deps.userAuthz, input.projectId);
  const { custom } = input;
  const { probe, server } = await probeCustomServer(custom, deps);
  if (URL.parse(custom.confirmIssuerOrigin)?.origin !== probe.issuerOrigin) {
    throw new ManagedConnectionIssuerChangedError(probe.issuerOrigin);
  }
  const definition: ManagedConnectionDefinition = {
    name: custom.name,
    label: custom.label ?? custom.name,
    preset: null,
    server:
      custom.scopes === undefined
        ? server
        : { ...server, scopes: [...new Set(custom.scopes)] },
  };
  return await startManagedConnection(
    { projectId: input.projectId, definition, binding: input.binding },
    deps,
  );
};
