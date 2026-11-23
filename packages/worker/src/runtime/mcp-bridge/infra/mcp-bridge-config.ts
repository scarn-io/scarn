import { defaultHostRelayBindAddress } from "../../git-credentials/infra/git-credential-relay-config";

type Env = Record<string, string | undefined>;

/**
 * The address the MCP bridge server binds: `SCARN_MCP_BRIDGE_BIND` (trimmed)
 * when set, otherwise the same default as the git credential relay
 * (`127.0.0.1` on macOS and Windows, `0.0.0.0` on Linux).
 */
export function resolveMcpBridgeBindAddress(
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string {
  return (
    env["SCARN_MCP_BRIDGE_BIND"]?.trim() ||
    defaultHostRelayBindAddress(platform)
  );
}
