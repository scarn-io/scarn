import { createHash, randomBytes } from "node:crypto";

/**
 * One-way digests of the values that identify a managed launch. Only digests
 * are stored: the relay capability is shown once to the worker, the claim
 * token belongs to the run's claim, and the MCP session ID is the provider's.
 * Each digest is domain-separated by a label, so a value from one role never
 * matches a digest from another. Lookups compare digests by equality in
 * Postgres, so no constant-time comparison is needed here.
 */
const digest = (label: string, value: string): Buffer =>
  createHash("sha256").update(`${label}|${value}`).digest();

export const relayCapabilityDigest = (capability: string): Buffer =>
  digest("managed-relay-capability:v1", capability);

export const launchClaimTokenDigest = (claimToken: string): Buffer =>
  digest("managed-launch-claim-token:v1", claimToken);

export const mcpSessionIdDigest = (sessionId: string): Buffer =>
  digest("managed-mcp-session-id:v1", sessionId);

/** A new relay capability: 256 bits of randomness, base64url (43 chars). */
export const randomRelayCapability = (): string =>
  randomBytes(32).toString("base64url");
