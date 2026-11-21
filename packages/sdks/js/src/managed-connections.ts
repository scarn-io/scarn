/**
 * Managed MCP connection names and MCP resource URL normalization. A step's
 * MCP server with `auth: { connection }` names one of the project's managed
 * connections; the connection owns the resource the server must point at,
 * and the server checks the step's URL against it.
 */
import { z } from "zod";

/** A managed connection's name: lowercase kebab-case, 1–63 characters. */
export const managedConnectionNameSchema = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "must be lowercase kebab-case (letters, digits and hyphens)",
  });

export type ManagedConnectionName = z.infer<typeof managedConnectionNameSchema>;

/**
 * `url` with its scheme and host lowercased, a default port dropped and a
 * trailing slash removed. Null when `url` isn't an absolute `http(s)` URL or
 * carries a query string, fragment or credentials.
 */
export function normalizeMcpResourceUrl(url: string): string | null {
  if (url.includes("?") || url.includes("#")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

/** The path the CLI's loopback listener catches a managed connection's sign-in redirect on. */
export const MANAGED_CONNECTION_LOOPBACK_CALLBACK_PATH = "/callback";

/**
 * The port the CLI catches a sign-in on when the authorization server won't
 * let a loopback redirect's port vary (RFC 8252 §7.3). Unassigned in the IANA
 * registry and below the Linux and macOS ephemeral ranges.
 */
export const MANAGED_CONNECTION_LOOPBACK_FALLBACK_PORT = 28418;
