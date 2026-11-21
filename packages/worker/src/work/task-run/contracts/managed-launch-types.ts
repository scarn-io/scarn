import type { UuidV7 } from "../../../common/contracts/uuid-v7";

/** A managed launch's relay entries, by the step's MCP server key. */
export type ManagedLaunchEntries = Readonly<
  Record<string, { relayUrl: string; capability: string }>
>;

/** MCP server URLs as the worker resolved them, by the step's MCP server key. */
export type ManagedLaunchUrls = Readonly<Record<string, { url: string }>>;

/**
 * What the server checks a launch's MCP servers against its project's
 * connections with (ADR 0013 decision 40): the resolved URL of each enabled
 * entry with `auth: { connection }`, and of each other enabled remote entry.
 * `{env:X}` placeholders are left unresolved, so no variable value is sent.
 */
export type ManagedLaunchServerUrls = {
  entries: ManagedLaunchUrls;
  remotesWithoutAuth: ManagedLaunchUrls;
};

/** A claimed run's launch registration request. */
export type ManagedLaunchRegistration = ManagedLaunchServerUrls & {
  taskRunId: UuidV7;
  claimToken: string;
};

/**
 * Registers the run's managed launch once the launch knows its step uses a
 * managed connection; resolves the relay entries with each URL as the MCP
 * client reaches it from `runtimeKind`. An `mcp_tool` launch passes `"host"`,
 * since its client is the worker process itself.
 */
export type RegisterManagedLaunch = (
  input: ManagedLaunchServerUrls & {
    runtimeKind: "host" | "devcontainer" | "managed";
  },
) => Promise<ManagedLaunchEntries>;

/** {@link RegisterManagedLaunch} with the launch's runtime already bound. */
export type RegisterLaunchServers = (
  urls: ManagedLaunchServerUrls,
) => Promise<ManagedLaunchEntries>;
