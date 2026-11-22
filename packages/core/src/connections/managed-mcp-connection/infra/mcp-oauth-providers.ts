import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type {
  ManagedOAuthProviderTarget,
  ManagedOAuthProviders,
} from "../application/managed-oauth-providers";
import type { ManagedConnectionPresets } from "../application/managed-connection-preset";
import type { ManagedOAuthProvider } from "../application/oauth-provider";
import { managedConnectionDiscoveryKey } from "../domain/managed-connection-discovery";
import type { ManagedConnectionGuards } from "./managed-connection-guards";
import { McpOAuthProvider } from "./mcp-oauth-provider";

export type McpOAuthProvidersOptions = {
  timeProvider: TimeProvider;
  /** Where each connection's outbound guard comes from. */
  guards: ManagedConnectionGuards;
  /** The catalog a connection's preset key is looked up in. */
  presets: ManagedConnectionPresets;
};

/**
 * Builds one `McpOAuthProvider` per connection server, each with that
 * server's guard from {@link ManagedConnectionGuards}, and caches it so
 * discovery is shared by connections to the same server. An unknown preset
 * key gets the generic behaviour.
 */
export class McpOAuthProviders implements ManagedOAuthProviders {
  private readonly options: McpOAuthProvidersOptions;
  private readonly providers = new Map<string, ManagedOAuthProvider>();

  constructor(options: McpOAuthProvidersOptions) {
    this.options = options;
  }

  for({ server, preset }: ManagedOAuthProviderTarget): ManagedOAuthProvider {
    const key = [
      server.resource,
      server.issuerOrigin,
      server.clientRegistration,
      managedConnectionDiscoveryKey(server.discovery),
      preset ?? "",
    ].join("|");
    const cached = this.providers.get(key);
    if (cached) {
      return cached;
    }
    const provider = new McpOAuthProvider({
      guardedFetch: this.options.guards.for(server),
      timeProvider: this.options.timeProvider,
      server,
      preset: preset === null ? null : this.options.presets.get(preset),
    });
    this.providers.set(key, provider);
    return provider;
  }
}
