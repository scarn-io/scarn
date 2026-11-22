import { createHmac, timingSafeEqual } from "node:crypto";
import { getBetterAuthSecret } from "@scarn/identity";

const SEPARATOR = ".";
const MAX_AGE_MS = 15 * 60 * 1000;

export type InstallStateIntent = "create" | "link";

export type InstallStateClaims =
  | { intent: "link"; projectId: string; iat: number }
  | {
      intent: "create";
      projectId?: undefined;
      /** Same-origin path to land on after the install; see {@link safeReturnToPath}. */
      returnTo?: string;
      iat: number;
    };

type RawInstallStateClaims = {
  intent?: unknown;
  projectId?: unknown;
  returnTo?: unknown;
  iat?: unknown;
};

const MAX_RETURN_TO_LENGTH = 2048;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
};

const RETURN_TO_BASE = "http://return-to.invalid";

/**
 * `value` when it is a same-origin path the install callback may redirect to,
 * else `null`. Mirrors the web app's `getSafeCallbackUrl` (must start with
 * `/`), and also refuses protocol-relative `//host` and `/\host` forms, control
 * characters, and anything that would resolve to another origin — so a signed
 * state can never become an open redirect.
 */
export const safeReturnToPath = (value: string): string | null => {
  if (
    value.length === 0 ||
    value.length > MAX_RETURN_TO_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return null;
  }
  try {
    const resolved = new URL(value, RETURN_TO_BASE);
    return resolved.origin === RETURN_TO_BASE ? value : null;
  } catch {
    return null;
  }
};

export class InstallStateError extends Error {
  constructor(
    message: string,
    public readonly reason:
      "malformed" | "signature_mismatch" | "expired" | "invalid_payload",
  ) {
    super(message);
    this.name = "InstallStateError";
  }
}

const sign = (payload: string): string =>
  createHmac("sha256", getBetterAuthSecret())
    .update(payload)
    .digest("base64url");

export type SignInstallStateInput =
  | { intent: "link"; projectId: string }
  | { intent: "create"; returnTo?: string | undefined };

const createClaims = (returnTo: string | undefined): InstallStateClaims => {
  if (returnTo === undefined) {
    return { intent: "create", iat: Date.now() };
  }
  if (safeReturnToPath(returnTo) === null) {
    throw new InstallStateError(
      "Install state returnTo must be a same-origin path",
      "invalid_payload",
    );
  }
  return { intent: "create", returnTo, iat: Date.now() };
};

export const signInstallState = (input: SignInstallStateInput): string => {
  const claims: InstallStateClaims =
    input.intent === "link"
      ? { intent: "link", projectId: input.projectId, iat: Date.now() }
      : createClaims(input.returnTo);
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}${SEPARATOR}${sign(payload)}`;
};

export const verifyInstallState = (
  state: string,
  now: number = Date.now(),
): InstallStateClaims => {
  const [payload, signature] = state.split(SEPARATOR);
  if (!payload || !signature) {
    throw new InstallStateError("Malformed install state", "malformed");
  }

  const expected = sign(payload);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new InstallStateError(
      "Install state signature mismatch",
      "signature_mismatch",
    );
  }

  let raw: RawInstallStateClaims;
  try {
    raw = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as RawInstallStateClaims;
  } catch {
    throw new InstallStateError(
      "Install state payload invalid",
      "invalid_payload",
    );
  }
  if (typeof raw.iat !== "number") {
    throw new InstallStateError(
      "Install state payload invalid",
      "invalid_payload",
    );
  }
  if (raw.intent !== "create" && raw.intent !== "link") {
    throw new InstallStateError(
      "Install state payload invalid",
      "invalid_payload",
    );
  }

  let claims: InstallStateClaims;
  if (raw.intent === "link") {
    if (typeof raw.projectId !== "string" || !raw.projectId) {
      throw new InstallStateError(
        "Install state payload invalid",
        "invalid_payload",
      );
    }
    claims = { intent: "link", projectId: raw.projectId, iat: raw.iat };
  } else {
    if (typeof raw.projectId !== "undefined") {
      throw new InstallStateError(
        "Install state payload invalid",
        "invalid_payload",
      );
    }
    if (typeof raw.returnTo === "undefined") {
      claims = { intent: "create", iat: raw.iat };
    } else if (
      typeof raw.returnTo === "string" &&
      safeReturnToPath(raw.returnTo) !== null
    ) {
      claims = { intent: "create", returnTo: raw.returnTo, iat: raw.iat };
    } else {
      throw new InstallStateError(
        "Install state payload invalid",
        "invalid_payload",
      );
    }
  }

  if (now - claims.iat > MAX_AGE_MS) {
    throw new InstallStateError("Install state expired", "expired");
  }

  return claims;
};
