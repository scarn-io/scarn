import { z } from "zod";
import type { ManagedConnectionDiscovery } from "./managed-connection-discovery";

export const managedConnectionClientRegistrationValues = [
  "cimd",
  "dcr",
  "supplied",
] as const;

export const managedConnectionClientRegistrationSchema = z.enum(
  managedConnectionClientRegistrationValues,
);

/**
 * How Scarn identifies itself to the authorization server: a client ID
 * metadata document, dynamic client registration, or a public client the
 * user supplied (with its one fixed loopback redirect).
 */
export type ManagedConnectionClientRegistration = z.infer<
  typeof managedConnectionClientRegistrationSchema
>;

type ManagedConnectionServerBase = {
  /** The normalized MCP URL. */
  resource: string;
  /** The authorization server's origin. */
  issuerOrigin: string;
  /** The discovery overrides the server needs, when it needs any. */
  discovery?: ManagedConnectionDiscovery;
  /**
   * The scopes every sign-in asks for. When absent, a sign-in asks for what
   * the server's metadata advertises.
   */
  scopes?: readonly string[];
};

/**
 * The MCP server a connection talks to, fixed when the connection is created.
 * A preset only fills it in; the connection row is the source of truth after.
 * A `supplied` server carries the user's client ID and the exact loopback
 * redirect it is registered with; it is only ever signed in to from the CLI.
 */
export type ManagedConnectionServer =
  | (ManagedConnectionServerBase & { clientRegistration: "cimd" | "dcr" })
  | (ManagedConnectionServerBase & {
      clientRegistration: "supplied";
      suppliedClientId: string;
      suppliedRedirectUri: string;
    });

/** A server signed in to with a client the user supplied. */
export type SuppliedManagedConnectionServer = Extract<
  ManagedConnectionServer,
  { clientRegistration: "supplied" }
>;

/** What a new connection is created with: its server plus how it is named and shown. */
export type ManagedConnectionDefinition = {
  /** What `auth: { connection }` refers to; unique per project. */
  name: string;
  label: string;
  /** The preset key the connection was created from, if any. */
  preset: string | null;
  server: ManagedConnectionServer;
};
