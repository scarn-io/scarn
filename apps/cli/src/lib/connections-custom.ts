import type { DiscoveredMcpServer, SkippedAgentTool } from "@scarn/worker";
import { CliError } from "./cli-error";
import { confirmAction } from "./confirm-action";
import type {
  ConnectionsApi,
  ManagedMcpServerProbe,
  SuppliedClient,
} from "./connections-api";
import {
  sharedAuthorityDisclosure,
  type LoopbackSignInTarget,
} from "./connections-loopback";
import type { BaseReporter } from "./reporter-types";

/**
 * What `scarn connections connect <name>` signs in to (decisions 6 and 12).
 *
 * Resolution: `--preset` names a preset outright. Otherwise a remote entry
 * named `<name>` in the project's MCP config is a custom server, except that
 * an entry with no `oauth.clientId` whose URL is a preset's resource uses
 * that preset. Otherwise `<name>` must be a preset key.
 *
 * A custom server is probed first; its issuer, endpoint origins, the
 * discovery overrides it needs, how the client is registered and the
 * project-wide warning are shown, and the user
 * is asked to continue before anything is stored. A client ID in the config
 * is a supplied client, signed in on its one loopback redirect:
 * `oauth.redirectUri` as given, or `http://localhost:<oauth.callbackPort>/callback`
 * (Claude's format).
 *
 * Scopes (decision 11): `--scope`, repeated, else the config's space-separated
 * `oauth.scope`, are what every sign-in of a new custom connection asks for.
 * Like a client ID, scopes keep a config entry on a preset's URL custom.
 * Presets take no scopes, so `--scope` with one is refused. An existing
 * connection keeps the scopes it was created with.
 */

export interface ConnectTargetInput {
  api: ConnectionsApi;
  projectId: string;
  name: string;
  preset: string | undefined;
  /** From `--scope`; empty to use the config's `oauth.scope`, if any. */
  scopes: readonly string[];
  /** The project's MCP config, as `discoverRepoAgentTools` found it. */
  servers: readonly DiscoveredMcpServer[];
  skipped: readonly SkippedAgentTool[];
  yes: boolean;
  reporter: BaseReporter;
  isTty?: boolean;
  prompt?: (message: string) => Promise<boolean>;
}

export type CustomServerEntry = {
  name: string;
  source: string;
  resource: string;
  client: SuppliedClient | null;
  /** The config's `oauth.scope`, split; null when it sets none. */
  scopes: string[] | null;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const comparableUrl = (url: string): string =>
  URL.canParse(url) ? new URL(url).href.replace(/\/$/u, "") : url;

function suppliedRedirect(
  oauth: { redirect_uri?: string; callback_port?: number },
  where: string,
): string {
  const redirectUri =
    oauth.redirect_uri ??
    (oauth.callback_port === undefined
      ? undefined
      : `http://localhost:${String(oauth.callback_port)}/callback`);
  if (redirectUri === undefined) {
    throw new CliError(
      "invalid_usage",
      `${where} sets oauth.clientId but no redirect. Add \`oauth.callbackPort\` or \`oauth.redirectUri\` (the redirect that client is registered with).`,
    );
  }
  const parsed = URL.canParse(redirectUri) ? new URL(redirectUri) : null;
  if (
    parsed === null ||
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.port === "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new CliError(
      "invalid_usage",
      `${where} redirects to ${redirectUri}, which the CLI can't listen on. It must be http://localhost, 127.0.0.1 or [::1] with a port.`,
    );
  }
  return redirectUri;
}

/** The custom server a discovered MCP config entry describes. */
export function customServerFromConfig(
  server: DiscoveredMcpServer,
): CustomServerEntry {
  const where = `"${server.name}" in ${server.source}`;
  const { config } = server;
  if (config.type !== "remote") {
    throw new CliError(
      "invalid_usage",
      `${where} is a local (stdio) server. Only remote MCP servers with a url can be connected.`,
    );
  }
  if (config.url.includes("{env:")) {
    throw new CliError(
      "invalid_usage",
      `${where} reads environment variables in its url, so Scarn can't tell which server to connect.`,
    );
  }
  const oauth = config.oauth === false ? undefined : config.oauth;
  const clientId = oauth?.client_id;
  const scopes = oauth?.scope?.split(/\s+/u).filter(Boolean) ?? [];
  return {
    name: server.name,
    source: server.source,
    resource: config.url,
    client:
      oauth === undefined || clientId === undefined || clientId === ""
        ? null
        : { clientId, redirectUri: suppliedRedirect(oauth, where) },
    scopes: scopes.length === 0 ? null : scopes,
  };
}

function clientLine(probe: ManagedMcpServerProbe, entry: CustomServerEntry) {
  if (entry.client !== null) {
    return `Signs in as client \`${entry.client.clientId}\` from your MCP config. The provider sees requests as coming from that app.`;
  }
  const how =
    probe.clientRegistration === "cimd"
      ? "a client ID metadata document (CIMD)"
      : "dynamic client registration (DCR)";
  return `Scarn registers its own client, using ${how}.`;
}

/** One line per discovery override the server needs, for the user to check. */
function overrideLines(probe: ManagedMcpServerProbe): string[] {
  const { overrides } = probe;
  return [
    overrides.resourceMetadataUrl === undefined
      ? null
      : `Protected resource metadata from: ${overrides.resourceMetadataUrl}`,
    overrides.advertisedResource === undefined
      ? null
      : `Tokens are issued for: ${overrides.advertisedResource}`,
    overrides.endpointOrigins === undefined
      ? null
      : `Sign-in and token endpoints also on: ${overrides.endpointOrigins.join(", ")}`,
    overrides.tokenErrors === undefined
      ? null
      : "Token errors are read the way Slack reports them",
  ].filter((line): line is string => line !== null);
}

/**
 * Probes a custom server, shows what was found and asks to continue; the
 * target to sign in, or `null` when the user declined.
 */
export async function confirmCustomServer(
  input: ConnectTargetInput,
  entry: CustomServerEntry,
): Promise<LoopbackSignInTarget | null> {
  const { api, projectId, reporter } = input;
  const client = entry.client ?? undefined;
  const probe = await api.probe({
    projectId,
    resource: entry.resource,
    ...(client === undefined ? {} : { client }),
  });
  reporter.info(
    [
      `Connecting "${entry.name}" from ${entry.source}: ${probe.resource}`,
      `Authorization server: ${probe.issuerOrigin}`,
      `Endpoint origins: ${probe.endpointOrigins.join(", ")}`,
      ...overrideLines(probe),
      clientLine(probe, entry),
      entry.scopes === null
        ? "Requests the scopes the server advertises."
        : `Requests scopes: ${entry.scopes.join(" ")}`,
    ].join("\n"),
  );
  const overrides = overrideLines(probe);
  if (overrides.length > 0) {
    reporter.warn(
      "This server doesn't follow the MCP authorization spec, so Scarn signs in to it with the adjustments above.",
    );
  }
  reporter.warn(sharedAuthorityDisclosure(entry.name));
  const proceed = await confirmAction({
    message: "Continue?",
    yes: input.yes,
    ...(input.isTty === undefined ? {} : { isTty: input.isTty }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
  });
  if (!proceed) {
    reporter.info("Cancelled. Nothing was connected.");
    return null;
  }
  return {
    kind: "custom",
    custom: {
      name: entry.name,
      resource: entry.resource,
      confirmIssuerOrigin: probe.issuerOrigin,
      ...(client === undefined ? {} : { client }),
      ...(entry.scopes === null ? {} : { scopes: entry.scopes }),
    },
    suppliedRedirectUri: client?.redirectUri ?? null,
  };
}

async function existingSuppliedRedirect(input: ConnectTargetInput) {
  const existing = (await input.api.list(input.projectId)).find(
    (connection) => connection.name === input.name,
  );
  return existing?.suppliedClient?.redirectUri ?? null;
}

/** Resolves `connect <name>`; see the module comment. `null` if declined. */
export async function resolveConnectTarget(
  input: ConnectTargetInput,
): Promise<LoopbackSignInTarget | null> {
  const { api, projectId, name } = input;
  const presetTarget = async (
    preset: string,
  ): Promise<LoopbackSignInTarget> => {
    if (input.scopes.length > 0) {
      throw new CliError(
        "invalid_usage",
        `"${preset}" is a known service, which asks for the scopes its server advertises. --scope only applies to a remote server from your MCP config.`,
      );
    }
    return {
      kind: "connect",
      preset,
      name,
      suppliedRedirectUri: await existingSuppliedRedirect(input),
    };
  };
  if (input.preset !== undefined) return presetTarget(input.preset);

  const presets = await api.listPresets(projectId);
  const configured = input.servers.find((server) => server.name === name);
  const isPreset = presets.some((preset) => preset.key === name);
  if (
    configured !== undefined &&
    (configured.transport === "remote" || !isPreset)
  ) {
    const configEntry = customServerFromConfig(configured);
    const entry =
      input.scopes.length === 0
        ? configEntry
        : { ...configEntry, scopes: [...new Set(input.scopes)] };
    const samePreset = presets.find(
      (preset) =>
        comparableUrl(preset.resource) === comparableUrl(entry.resource),
    );
    if (
      entry.client === null &&
      entry.scopes === null &&
      samePreset !== undefined
    ) {
      return presetTarget(samePreset.key);
    }
    return confirmCustomServer(input, entry);
  }
  if (isPreset) return presetTarget(name);

  const skipped = input.skipped.find(
    (item) => item.kind === "server" && item.name === name,
  );
  const keys = presets.map((preset) => preset.key).join(", ");
  throw new CliError(
    "invalid_usage",
    skipped === undefined
      ? `"${name}" isn't a server in this project's MCP config or a known service. Add it to your MCP config, or pass --preset <key> (one of: ${keys}).`
      : `"${name}" in ${skipped.source} can't be used: ${skipped.reason}.`,
  );
}
