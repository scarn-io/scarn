import { normalizeMcpResourceUrl } from "@scarn/sdk/managed-connections";
import type {
  ManagedConnectionClientRegistration,
  ManagedConnectionDefinition,
} from "../domain/managed-connection-server";
import type { ManagedGrantIdentity } from "./managed-grant-crypto";

/**
 * A known MCP service a connection can be created from. It fills in the
 * connection's server and carries the server-only behaviour that service
 * needs; the connection row stays the source of truth after creation.
 */
export type ManagedConnectionPreset = {
  label: string;
  /** The MCP URL; normalized when a connection is created from it. */
  resource: string;
  issuerOrigin: string;
  /** Presets never supply a client (decision 6). */
  clientRegistration: Exclude<ManagedConnectionClientRegistration, "supplied">;
  /** Where people remove Scarn's access on the provider's side. */
  removalUrl?: string;
  /** Reads who signed in from the raw token response; null when the identity fields are malformed. */
  // eslint-disable-next-line local/no-unknown-parameter-type -- parses the raw token response
  parseIdentity?: (tokenJson: unknown) => ManagedGrantIdentity | null;
  /** Whether the callback must carry `iss` when the server advertises support for it. */
  requireIssParameter: boolean;
  /** Whether connecting again revokes the grant it replaces. */
  revokeReplacedGrants: boolean;
};

/** The core preset catalog, as the application layer reads it. */
export interface ManagedConnectionPresets {
  /** The preset with this key, or null when the catalog has none. */
  get(key: string): ManagedConnectionPreset | null;
  /** Every preset, in catalog order. */
  list(): { key: string; preset: ManagedConnectionPreset }[];
}

/** A new connection's definition from preset `key`, named `name`. */
export function managedConnectionDefinitionOf(
  key: string,
  preset: ManagedConnectionPreset,
  name: string,
): ManagedConnectionDefinition {
  const resource = normalizeMcpResourceUrl(preset.resource);
  if (resource === null) {
    throw new Error(`Preset ${key} has an invalid MCP resource URL`);
  }
  return {
    name,
    label: preset.label,
    preset: key,
    server: {
      resource,
      issuerOrigin: preset.issuerOrigin,
      clientRegistration: preset.clientRegistration,
    },
  };
}
