import { z } from "zod";
import { managedConnectionNameSchema } from "@scarn/sdk/managed-connections";
import { managedConnectionDiscoverySchema } from "../domain/managed-connection-discovery";

/**
 * Custom MCP servers from the user's MCP config (decision 12): the CLI
 * probes the URL, shows the issuer it found, and starts the connection with
 * the issuer origin the user confirmed.
 */

/**
 * A public client from the user's MCP config and the one loopback redirect
 * it is registered with.
 */
export const suppliedManagedClientSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    redirectUri: z.string().min(1).max(2048),
  })
  .strict();

const customResourceSchema = z.string().min(1).max(2048);

export const probeManagedMcpServerSchema = z
  .object({
    resource: customResourceSchema,
    client: suppliedManagedClientSchema.optional(),
  })
  .strict();

export type ProbeManagedMcpServerInput = z.infer<
  typeof probeManagedMcpServerSchema
>;

/**
 * What probing found, with nothing stored. `clientRegistration` is how
 * Scarn would sign in: the supplied client when one was sent, else a client
 * ID metadata document when supported, else dynamic registration.
 * `overrides` holds the discovery overrides the server needed (decision
 * 10), each set only when needed; the connection is stored with them.
 */
export const managedMcpServerProbeSchema = z.object({
  resource: z.string(),
  issuerOrigin: z.string(),
  endpointOrigins: z.array(z.string()),
  clientRegistration: z.enum(["cimd", "dcr", "supplied"]),
  supports: z.object({ cimd: z.boolean(), dcr: z.boolean() }),
  overrides: managedConnectionDiscoverySchema,
});

export type ManagedMcpServerProbeContract = z.infer<
  typeof managedMcpServerProbeSchema
>;

/** One OAuth scope token (RFC 6749 section 3.3). */
const scopeTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/u, "must be an OAuth scope token");

/**
 * A custom server to create the connection `name` for. `label` defaults to
 * `name`. `confirmIssuerOrigin` is the issuer origin the probe showed; the
 * connection is created only if a fresh probe still finds it. `scopes` are
 * what every sign-in asks for (decision 11); omitted, a sign-in asks for
 * what the server's metadata advertises. They are fixed when the connection
 * is created: restarting an existing connection keeps its stored scopes.
 */
export const customManagedConnectionSchema = z
  .object({
    name: managedConnectionNameSchema,
    label: z.string().trim().min(1).max(200).optional(),
    resource: customResourceSchema,
    client: suppliedManagedClientSchema.optional(),
    scopes: z.array(scopeTokenSchema).min(1).max(100).optional(),
    confirmIssuerOrigin: z.string().min(1).max(2048),
  })
  .strict();

export type CustomManagedConnectionInput = z.infer<
  typeof customManagedConnectionSchema
>;
