/**
 * Git's credential-helper wire format (`gitcredentials(7)`, `git-credential(1)`).
 *
 * A message is a stream of `key=value\n` lines that ends at a blank line or at
 * EOF. Only the attributes the relay acts on are kept: `protocol`, `host` and
 * `path` for a request, plus `username`, `password` and `password_expiry_utc`
 * for a credential. Unknown keys are ignored and multi-valued keys
 * (`capability[]`, `wwwauth[]`) are dropped.
 *
 * Errors never quote a value: a message may carry a password.
 */

export type GitCredentialQuery = {
  protocol: string;
  host: string;
  path: string | null;
};

export type GitCredential = {
  username: string;
  password: string;
  expiresAt: Date | null;
};

export class GitCredentialProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCredentialProtocolError";
  }
}

const QUIT_BODY = "quit=1\n";

/** Parse a credential request. Throws when `protocol` or `host` is missing. */
export function parseGitCredentialQuery(body: string): GitCredentialQuery {
  const attributes = parseAttributes(body);
  const protocol = attributes.get("protocol");
  const host = attributes.get("host");
  if (!protocol) {
    throw new GitCredentialProtocolError(
      "Credential request is missing 'protocol'.",
    );
  }
  if (!host) {
    throw new GitCredentialProtocolError(
      "Credential request is missing 'host'.",
    );
  }
  return { protocol, host, path: attributes.get("path") ?? null };
}

/**
 * Parse a credential answer (e.g. `git credential fill` output). Returns
 * `null` when it carries no password.
 */
export function parseGitCredential(body: string): GitCredential | null {
  const attributes = parseAttributes(body);
  const password = attributes.get("password");
  if (!password) {
    return null;
  }
  return {
    username: attributes.get("username") ?? "",
    password,
    expiresAt: parseExpiry(attributes.get("password_expiry_utc")),
  };
}

export function serializeGitCredentialQuery(query: GitCredentialQuery): string {
  return serializeAttributes([
    ["protocol", query.protocol],
    ["host", query.host],
    ...(query.path === null ? [] : [["path", query.path] as const]),
  ]);
}

export function serializeGitCredential(credential: GitCredential): string {
  return serializeAttributes([
    ["username", credential.username],
    ["password", credential.password],
    ...(credential.expiresAt === null
      ? []
      : [
          [
            "password_expiry_utc",
            String(Math.floor(credential.expiresAt.getTime() / 1000)),
          ] as const,
        ]),
  ]);
}

/** `quit=1` stops git from asking any further helper. */
export function serializeQuit(): string {
  return QUIT_BODY;
}

function parseAttributes(body: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      break;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new GitCredentialProtocolError(
        "Credential message has a line that is not 'key=value'.",
      );
    }
    const key = line.slice(0, separator);
    if (key.endsWith("[]")) {
      continue;
    }
    attributes.set(key, line.slice(separator + 1));
  }
  return attributes;
}

function parseExpiry(raw: string | undefined): Date | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  return new Date(Number(raw) * 1000);
}

function serializeAttributes(
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  return entries
    .map(([key, value]) => {
      if (/[\n\r\0]/.test(value)) {
        throw new GitCredentialProtocolError(
          `Credential attribute '${key}' contains a newline or NUL.`,
        );
      }
      return `${key}=${value}\n`;
    })
    .join("");
}
