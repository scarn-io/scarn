import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedOpenCodeMcpServerConfig } from "../contracts/opencode-mcp";

/**
 * MCP client transports shared by everything in the worker that talks to an
 * MCP server directly (the designer's tool lister, the `mcp_tool` step
 * caller): `{env:VAR}` substitution, the stdio launch of a `local` server,
 * and the Streamable HTTP → SSE candidates for a `remote` one.
 */

export type LocalMcpServerConfig = Extract<
  ResolvedOpenCodeMcpServerConfig,
  { type: "local" }
>;
export type RemoteMcpServerConfig = Extract<
  ResolvedOpenCodeMcpServerConfig,
  { type: "remote" }
>;

const ENV_PLACEHOLDER = /\{env:([^}]+)\}/gu;
const BASIC_PLACEHOLDER = /\{basic:([^}:]*):([^}]*)\}/gu;

/** `base64(user + ":" + password)`, UTF-8 encoded: a `Basic` credential. */
export function encodeBasicCredentials(user: string, password: string): string {
  return Buffer.from(`${user}:${password}`, "utf8").toString("base64");
}

/**
 * Replace every `{env:VAR}` with `env[VAR]`, and every
 * `{basic:USER_VAR:PASS_VAR}` with {@link encodeBasicCredentials} of the two,
 * each unset variable read as `""`.
 */
export function substituteEnv(
  value: string,
  env: Readonly<Record<string, string>>,
): string {
  return value
    .replace(BASIC_PLACEHOLDER, (_, user: string, password: string) =>
      encodeBasicCredentials(env[user] ?? "", env[password] ?? ""),
    )
    .replace(ENV_PLACEHOLDER, (_, name: string) => env[name] ?? "");
}

/**
 * The encoded credential of every `{basic:…}` in `servers`' remote headers,
 * resolved against `env`, for the log masker: a server or an error can echo
 * the header back.
 */
export function basicCredentialSecretValues(
  servers: Readonly<Record<string, ResolvedOpenCodeMcpServerConfig>>,
  env: Readonly<Record<string, string>>,
): string[] {
  const values = new Set<string>();
  for (const server of Object.values(servers)) {
    if (server.type !== "remote") continue;
    for (const header of Object.values(server.headers ?? {})) {
      for (const [, user = "", password = ""] of header.matchAll(
        BASIC_PLACEHOLDER,
      )) {
        const userValue = env[user] ?? "";
        const passwordValue = env[password] ?? "";
        if (userValue === "" && passwordValue === "") continue;
        values.add(encodeBasicCredentials(userValue, passwordValue));
      }
    }
  }
  return [...values];
}

/**
 * A `local` server's argv, its own `environment` and its `cwd` (relative to
 * the place it runs, unresolved), all with `{env:VAR}` substituted.
 */
export type LocalMcpLaunch = {
  command: [string, ...string[]];
  environment: Record<string, string>;
  cwd: string | undefined;
};

export function resolveLocalMcpLaunch(
  config: LocalMcpServerConfig,
  env: Readonly<Record<string, string>>,
): LocalMcpLaunch {
  const resolve = (value: string) => substituteEnv(value, env);
  const [command = "", ...args] = config.command.map(resolve);
  return {
    command: [command, ...args],
    environment: Object.fromEntries(
      Object.entries(config.environment ?? {}).map(([key, value]) => [
        key,
        resolve(value),
      ]),
    ),
    cwd: config.cwd === undefined ? undefined : resolve(config.cwd),
  };
}

export function createStdioMcpTransport(input: {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  stderr: "ignore" | "pipe";
}): StdioClientTransport {
  return new StdioClientTransport({
    command: input.command,
    args: input.args,
    env: input.env,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    stderr: input.stderr,
  });
}

export type RemoteMcpEndpoint = {
  url: URL;
  headers: Record<string, string>;
};

export function resolveRemoteMcpEndpoint(
  config: RemoteMcpServerConfig,
  env: Readonly<Record<string, string>>,
): RemoteMcpEndpoint {
  return {
    url: new URL(substituteEnv(config.url, env)),
    headers: Object.fromEntries(
      Object.entries(config.headers ?? {}).map(([key, value]) => [
        key,
        substituteEnv(value, env),
      ]),
    ),
  };
}

/**
 * Fresh transports to try in order for a remote server: Streamable HTTP
 * first, SSE second, as OpenCode does.
 */
export function remoteMcpTransportCandidates(
  endpoint: RemoteMcpEndpoint,
): [() => Transport, () => Transport] {
  const requestInit = { headers: endpoint.headers };
  return [
    () => new StreamableHTTPClientTransport(endpoint.url, { requestInit }),
    () =>
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the SSE fallback OpenCode also keeps for older servers
      new SSEClientTransport(endpoint.url, { requestInit }),
  ];
}
