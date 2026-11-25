import {
  managedConnectionDefinitionOf,
  type ManagedConnectionPreset,
  type ManagedConnectionPresets,
} from "../application/managed-connection-preset";
import type { ManagedConnectionDefinition } from "../domain/managed-connection-server";
import { parseNotionIdentity } from "./notion-identity";

/** The MCP services Scarn knows how to connect to, keyed by preset key. */
export const MANAGED_CONNECTION_PRESETS = {
  notion: {
    label: "Notion",
    resource: "https://mcp.notion.com/mcp",
    issuerOrigin: "https://mcp.notion.com",
    clientRegistration: "cimd",
    removalUrl: "https://www.notion.so/profile/integrations",
    parseIdentity: parseNotionIdentity,
    requireIssParameter: true,
    revokeReplacedGrants: false,
  },
  "cloudflare-observability": {
    label: "Cloudflare Observability",
    resource: "https://observability.mcp.cloudflare.com/mcp",
    issuerOrigin: "https://observability.mcp.cloudflare.com",
    clientRegistration: "dcr",
    requireIssParameter: false,
    revokeReplacedGrants: false,
  },
  linear: {
    label: "Linear",
    resource: "https://mcp.linear.app/mcp",
    issuerOrigin: "https://mcp.linear.app",
    clientRegistration: "cimd",
    requireIssParameter: false,
    revokeReplacedGrants: false,
  },
  sentry: {
    label: "Sentry",
    resource: "https://mcp.sentry.dev/mcp",
    issuerOrigin: "https://mcp.sentry.dev",
    clientRegistration: "cimd",
    requireIssParameter: false,
    revokeReplacedGrants: false,
  },
  neon: {
    label: "Neon",
    resource: "https://mcp.neon.tech/mcp",
    issuerOrigin: "https://mcp.neon.tech",
    clientRegistration: "cimd",
    requireIssParameter: false,
    revokeReplacedGrants: false,
  },
  posthog: {
    label: "PostHog",
    resource: "https://mcp.posthog.com/mcp",
    issuerOrigin: "https://oauth.posthog.com",
    clientRegistration: "cimd",
    requireIssParameter: false,
    revokeReplacedGrants: false,
  },
  stripe: {
    label: "Stripe",
    resource: "https://mcp.stripe.com",
    issuerOrigin: "https://access.stripe.com",
    clientRegistration: "dcr",
    requireIssParameter: false,
    revokeReplacedGrants: false,
  },
  netlify: {
    label: "Netlify",
    resource: "https://netlify-mcp.netlify.app/mcp",
    issuerOrigin: "https://netlify-mcp.netlify.app",
    clientRegistration: "dcr",
    requireIssParameter: false,
    revokeReplacedGrants: false,
  },
  atlassian: {
    label: "Atlassian",
    resource: "https://mcp.atlassian.com/v2/mcp",
    issuerOrigin: "https://auth.atlassian.com",
    clientRegistration: "cimd",
    scopes: [
      "read:me",
      "read:account",
      "offline_access",
      "read:jira:agent-interface",
      "search:jira:agent-interface",
    ],
    removalUrl: "https://id.atlassian.com/manage-profile/apps",
    requireIssParameter: false,
    revokeReplacedGrants: false,
  },
} satisfies Record<string, ManagedConnectionPreset>;

export type ManagedConnectionPresetKey =
  keyof typeof MANAGED_CONNECTION_PRESETS;

export const isManagedConnectionPresetKey = (
  key: string,
): key is ManagedConnectionPresetKey =>
  Object.hasOwn(MANAGED_CONNECTION_PRESETS, key);

export function managedConnectionPresetFor(
  key: string,
): ManagedConnectionPreset | null {
  return isManagedConnectionPresetKey(key)
    ? MANAGED_CONNECTION_PRESETS[key]
    : null;
}

/** {@link MANAGED_CONNECTION_PRESETS} behind the application layer's port. */
export const managedConnectionPresetCatalog: ManagedConnectionPresets = {
  get: managedConnectionPresetFor,
  list: () =>
    Object.entries(MANAGED_CONNECTION_PRESETS).map(([key, preset]) => ({
      key,
      preset,
    })),
};

/** A new connection's definition from preset `key`, named `name` or else the key. */
export function managedConnectionDefinitionFromPreset(
  key: ManagedConnectionPresetKey,
  name: string = key,
): ManagedConnectionDefinition {
  return managedConnectionDefinitionOf(
    key,
    MANAGED_CONNECTION_PRESETS[key],
    name,
  );
}
