import type {
  ManagedConnectionClientRegistration,
  ManagedConnectionServer,
} from "../domain/managed-connection-server";
import type { ManagedOAuthClientRegistry } from "../application/managed-oauth-client-registry";
import type {
  ManagedOAuthClientIdentity,
  ManagedOAuthServerMetadata,
} from "../application/oauth-provider";
import { CimdClientRegistry } from "./cimd-client-registry";
import {
  DcrClientRegistry,
  type DcrClientRegistryOptions,
} from "./dcr-client-registry";
import { SuppliedClientRegistry } from "./supplied-client-registry";

/**
 * The one registry the use cases see: resolves through the registry for the
 * server's `clientRegistration`, and marks a client stale in every registry
 * (a client ID one of them didn't issue is left alone by it).
 */
export class ManagedOAuthClientRegistries implements ManagedOAuthClientRegistry {
  private readonly registries: Record<
    ManagedConnectionClientRegistration,
    ManagedOAuthClientRegistry
  >;

  constructor(
    registries: Record<
      ManagedConnectionClientRegistration,
      ManagedOAuthClientRegistry
    >,
  ) {
    this.registries = registries;
  }

  resolve(
    server: ManagedConnectionServer,
    metadata: ManagedOAuthServerMetadata,
    loopbackRedirectUri: string | null,
  ): Promise<ManagedOAuthClientIdentity> {
    return this.registries[server.clientRegistration].resolve(
      server,
      metadata,
      loopbackRedirectUri,
    );
  }

  async markStale(issuer: string, clientId: string): Promise<void> {
    for (const registry of Object.values(this.registries)) {
      await registry.markStale(issuer, clientId);
    }
  }
}

/** The registry for every registration method, DCR reaching servers through `guards`. */
export const managedOAuthClientRegistry = (
  options: DcrClientRegistryOptions,
): ManagedOAuthClientRegistry =>
  new ManagedOAuthClientRegistries({
    cimd: new CimdClientRegistry(options.apiBaseUrl),
    dcr: new DcrClientRegistry(options),
    supplied: new SuppliedClientRegistry(),
  });
