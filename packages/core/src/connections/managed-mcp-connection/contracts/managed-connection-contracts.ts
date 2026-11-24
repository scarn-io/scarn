import { z } from "zod";
import { managedConnectionNameSchema } from "@scarn/sdk/managed-connections";
import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { customManagedConnectionSchema } from "./custom-managed-connection-contracts";
import {
  managedConnectionReasonCodeValues,
  managedConnectionStateValues,
} from "../domain/managed-connection-entity";
import { managedRevocationOutcomeValues } from "../domain/managed-connection-event";
import { managedOAuthAttemptFailureCodeValues } from "../domain/managed-oauth-attempt-entity";

/**
 * Managed MCP connections as the API shows them. No contract carries token
 * material, a token suffix, or a provider user/workspace ID: only display
 * names, scopes and the candidate fingerprint the confirm call echoes back.
 */
export const managedConnectionAccountSchema = z.object({
  userName: z.string().nullable(),
  workspaceName: z.string().nullable(),
  /** True when the provider named both the user and the workspace the grant acts as. */
  identityVerified: z.boolean(),
});

export const managedConnectionCandidateSchema = z.object({
  id: uuidV7Schema,
  account: managedConnectionAccountSchema,
  grantedScopes: z.array(z.string()),
  /**
   * The connection's requested `scopes` the provider didn't grant. The
   * candidate can still be confirmed; empty when every one was granted or
   * the connection has no `scopes`.
   */
  missingScopes: z.array(z.string()),
  fingerprint: z.string(),
  expiresAt: z.iso.datetime(),
  /** Whether the candidate acts as the same provider account as the active grant. */
  sameIdentityAsActive: z.union([z.boolean(), z.literal("unknown")]),
});

export const managedConnectionSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  name: z.string(),
  label: z.string(),
  preset: z.string().nullable(),
  resource: z.string(),
  /** Origin of the authorization server the connection signs in with. */
  issuerOrigin: z.string(),
  /**
   * The client from the user's MCP config this connection signs in as, and
   * the one loopback redirect it accepts; null when Scarn is the client. A
   * connection with one can only be signed in to from the CLI.
   */
  suppliedClient: z
    .object({ clientId: z.string(), redirectUri: z.string() })
    .nullable(),
  /**
   * The scopes every sign-in asks for; null when a sign-in asks for what the
   * server's metadata advertises.
   */
  scopes: z.array(z.string()).nullable(),
  state: z.enum(managedConnectionStateValues),
  reasonCode: z.enum(managedConnectionReasonCodeValues).nullable(),
  generation: z.number().int().nonnegative(),
  /** Pass back as `expectedVersion` when confirming. */
  version: z.number().int().nonnegative(),
  connectedBy: z
    .object({ userId: uuidV7Schema, username: z.string().nullable() })
    .nullable(),
  /** The active grant's account; null while nothing is active. */
  account: managedConnectionAccountSchema.nullable(),
  grantedScopes: z.array(z.string()),
  reconnectBy: z.iso.datetime().nullable(),
  candidate: managedConnectionCandidateSchema.nullable(),
  /** Latest revocation in this generation; cleared by a fresh connect or audit retention. */
  lastRevocation: z
    .object({
      outcome: z.enum(managedRevocationOutcomeValues),
      at: z.iso.datetime(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ManagedConnectionAccountContract = z.infer<
  typeof managedConnectionAccountSchema
>;
export type ManagedConnectionCandidateContract = z.infer<
  typeof managedConnectionCandidateSchema
>;
export type ManagedConnectionContract = z.infer<typeof managedConnectionSchema>;

/** Starts a new connection from a preset; `name` defaults to the preset key. */
export const startManagedConnectionFromPresetSchema = z
  .object({
    preset: z.string().min(1).max(63),
    name: managedConnectionNameSchema.optional(),
  })
  .strict();

export type StartManagedConnectionFromPresetInput = z.infer<
  typeof startManagedConnectionFromPresetSchema
>;

/**
 * A preset a connection can be created from. `resource` is its normalized MCP
 * URL; `removalUrl` is where people remove Scarn's access on the provider's
 * side, or null when the preset names no such page.
 */
export const managedConnectionPresetSchema = z.object({
  key: z.string(),
  label: z.string(),
  resource: z.string(),
  removalUrl: z.string().nullable(),
});

export type ManagedConnectionPresetContract = z.infer<
  typeof managedConnectionPresetSchema
>;

export const startManagedConnectionResponseSchema = z.object({
  connectionId: uuidV7Schema,
  authorizationUrl: z.string(),
});

export type StartManagedConnectionResponse = z.infer<
  typeof startManagedConnectionResponseSchema
>;

/** The CLI's loopback listener; it must be loopback `http` (decision 4). */
const loopbackRedirectUriSchema = z.string().min(1).max(2048);

/**
 * Starts a new connection that the CLI completes from its loopback listener
 * at `redirectUri`: from a preset, or from a custom server in the user's MCP
 * config whose issuer origin the user confirmed after probing it.
 */
export const startManagedLoopbackConnectionSchema = z.union([
  z
    .object({
      preset: z.string().min(1).max(63),
      name: managedConnectionNameSchema.optional(),
      redirectUri: loopbackRedirectUriSchema,
    })
    .strict(),
  z
    .object({
      custom: customManagedConnectionSchema,
      redirectUri: loopbackRedirectUriSchema,
    })
    .strict(),
]);

export type StartManagedLoopbackConnectionInput = z.infer<
  typeof startManagedLoopbackConnectionSchema
>;

export const startManagedLoopbackReconnectSchema = z
  .object({ redirectUri: loopbackRedirectUriSchema })
  .strict();

/**
 * A loopback start. `completionSecret` is returned only here, once; the CLI
 * keeps it in memory and sends it back to complete attempt `attemptId`.
 * `redirectUri` is the redirect the authorization URL carries: the one the
 * CLI sent, or the fixed fallback port when the server won't let a loopback
 * port vary, which the CLI must then listen on instead.
 */
export const startManagedLoopbackResponseSchema =
  startManagedConnectionResponseSchema.extend({
    attemptId: uuidV7Schema,
    completionSecret: z.string(),
    redirectUri: z.string(),
  });

/**
 * Generous because some providers (e.g. Atlassian) issue authorization codes
 * as JWTs carrying every requested scope, which can run well past 2 KB.
 */
const MAX_LOOPBACK_PARAM_LENGTH = 8192;

/**
 * What the CLI's loopback listener caught: the provider's `state` with
 * either `code` (and `iss` when sent) or `error`, plus the attempt's
 * completion secret.
 */
export const completeManagedLoopbackAttemptSchema = z
  .object({
    completionSecret: z.string().min(1).max(256),
    state: z.string().min(1).max(MAX_LOOPBACK_PARAM_LENGTH),
    code: z.string().min(1).max(MAX_LOOPBACK_PARAM_LENGTH).optional(),
    iss: z.string().min(1).max(MAX_LOOPBACK_PARAM_LENGTH).optional(),
    error: z.string().min(1).max(MAX_LOOPBACK_PARAM_LENGTH).optional(),
  })
  .strict();

export type CompleteManagedLoopbackAttemptBody = z.infer<
  typeof completeManagedLoopbackAttemptSchema
>;

export const confirmManagedCandidateSchema = z
  .object({
    candidateId: uuidV7Schema,
    fingerprint: z.string().min(1).max(128),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ConfirmManagedCandidateInput = z.infer<
  typeof confirmManagedCandidateSchema
>;

export const cancelManagedCandidateSchema = z
  .object({ candidateId: uuidV7Schema })
  .strict();

export type CancelManagedCandidateInput = z.infer<
  typeof cancelManagedCandidateSchema
>;

/**
 * What disconnecting did. `revocation` is the outcome of the single
 * revocation request sent after the grant was deleted, or null when there was
 * no active grant to revoke (the connection was still connecting or awaiting
 * its first confirmation). Disconnecting can't promise the provider dropped
 * the tokens, so `providerRemovalUrl` is where people remove Scarn's access on
 * the provider's side: the connection's preset's, or null when it has no
 * preset or the preset names no such page.
 */
export const disconnectManagedConnectionResponseSchema = z.object({
  connection: managedConnectionSchema,
  revocation: z.enum(managedRevocationOutcomeValues).nullable(),
  providerRemovalUrl: z.string().nullable(),
});

export type DisconnectManagedConnectionResponse = z.infer<
  typeof disconnectManagedConnectionResponseSchema
>;

/** One tool the connection's MCP server offers, as the server described it. */
export const managedMcpToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: anyJsonObjectSchema,
  outputSchema: anyJsonObjectSchema.optional(),
  readOnlyHint: z.boolean().optional(),
});

/**
 * The tools the connection's MCP server offers. `cached` is true when they
 * were served from the short-lived discovery cache; `listedAt` is when they
 * were listed from the server.
 */
export const managedConnectionToolsSchema = z.object({
  tools: z.array(managedMcpToolSchema),
  listedAt: z.iso.datetime(),
  cached: z.boolean(),
});

export type ManagedConnectionToolsContract = z.infer<
  typeof managedConnectionToolsSchema
>;

export const managedConnectionUsageSchema = z.object({
  steps: z.array(
    z.object({
      id: uuidV7Schema,
      key: z.string(),
      name: z.string(),
      pipelines: z.array(
        z.object({
          id: uuidV7Schema,
          key: z.string(),
          name: z.string(),
        }),
      ),
    }),
  ),
  liveRuns: z.number().int().nonnegative(),
});

export type ManagedConnectionUsageContract = z.infer<
  typeof managedConnectionUsageSchema
>;

/**
 * The only values the OAuth callback ever puts on its redirect. Never anything
 * the provider sent.
 */
export const managedOAuthCallbackErrorValues = [
  ...managedOAuthAttemptFailureCodeValues,
  "attempt_expired",
] as const;

export type ManagedOAuthCallbackError =
  (typeof managedOAuthCallbackErrorValues)[number];
