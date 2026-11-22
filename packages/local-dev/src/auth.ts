/**
 * Resolves the signed-in user for `BASE_URL` from the CLI's auth store
 * (`~/.scarn/auth.jsonc`, keyed by origin). With no saved profile it
 * dev-logs in as `DEV_LOGIN_EMAIL`, finishes onboarding, and merges the new
 * profile into the store, leaving every other profile untouched.
 */
import { loadAuthProfile, saveAuthProfile } from "@scarn/sdk/defaults";

const DEV_LOGIN_HINT = "is `bun dev` running with `ENABLE_DEV_LOGIN=true`?";
const DEV_LOGIN_USERNAME = "local-dev";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  username: string | null;
  usernameChosen: boolean;
}

export interface LocalDevAuth {
  origin: string;
  token: string;
  headers: { Authorization: string };
  user: SessionUser;
  source: "profile" | "dev-login";
}

export async function preflight(baseUrl: string): Promise<void> {
  const url = new URL("/api/auth/get-session", baseUrl);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `[local-dev] GET ${url.toString()} failed (${String(error)}): ${DEV_LOGIN_HINT}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `[local-dev] GET ${url.toString()} returned ${String(response.status)}: ${DEV_LOGIN_HINT}`,
    );
  }
}

async function fetchSessionUser(
  baseUrl: string,
  token: string,
): Promise<SessionUser | null> {
  const response = await fetch(new URL("/api/auth/get-session", baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    user?: Partial<SessionUser>;
  } | null;
  const user = body?.user;
  if (!user?.id || !user.email) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? "",
    username: user.username ?? null,
    usernameChosen: user.usernameChosen === true,
  };
}

function tokenCandidates(setCookieHeaders: string[]): string[] {
  const candidates = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 0) candidates.add(trimmed);
  };

  for (const header of setCookieHeaders) {
    const pair = header.split(";")[0]?.trim() ?? "";
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const value = pair.slice(separator + 1).trim();
    const unquoted = value.replace(/^"+|"+$/g, "");
    add(value);
    add(unquoted);
    add(unquoted.split(".")[0] ?? "");
    try {
      const decoded = decodeURIComponent(unquoted);
      add(decoded);
      add(decoded.split(".")[0] ?? "");
    } catch {
      continue;
    }
  }

  return [...candidates];
}

async function devLogin(
  baseUrl: string,
  email: string,
): Promise<{ token: string; user: SessionUser }> {
  const response = await fetch(new URL("/api/dev/login", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[local-dev] dev login failed (${String(response.status)}): ${body.slice(0, 200)}\n${DEV_LOGIN_HINT}`,
    );
  }

  for (const candidate of tokenCandidates(response.headers.getSetCookie())) {
    const user = await fetchSessionUser(baseUrl, candidate);
    if (user) return { token: candidate, user };
  }
  throw new Error(
    "[local-dev] dev login returned no session token the API accepts",
  );
}

async function ensureOnboarded(
  baseUrl: string,
  token: string,
  user: SessionUser,
): Promise<SessionUser> {
  if (user.usernameChosen) return user;

  const response = await fetch(new URL("/api/username", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ username: DEV_LOGIN_USERNAME }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[local-dev] onboarding (set username "${DEV_LOGIN_USERNAME}") failed (${String(response.status)}): ${text.slice(0, 200)}`,
    );
  }

  const refreshed = await fetchSessionUser(baseUrl, token);
  if (!refreshed?.usernameChosen) {
    throw new Error("[local-dev] onboarding did not take effect");
  }
  return refreshed;
}

export async function resolveAuth(
  baseUrl: string,
  devLoginEmail: string,
): Promise<LocalDevAuth> {
  const origin = new URL(baseUrl).origin;
  const profile = loadAuthProfile(origin);

  if (profile) {
    const user = await fetchSessionUser(origin, profile.accessToken);
    if (!user) {
      throw new Error(
        `[local-dev] the saved profile for ${origin} in ~/.scarn/auth.jsonc is no longer valid. ` +
          `Sign in again with \`scarn auth login --base-url ${origin}\`, or remove that profile to dev-login as ${devLoginEmail}.`,
      );
    }
    if (!user.usernameChosen || !user.username) {
      throw new Error(
        `[local-dev] ${user.email} has not chosen a username yet. Finish onboarding at ${origin} first.`,
      );
    }
    return {
      origin,
      token: profile.accessToken,
      headers: { Authorization: `Bearer ${profile.accessToken}` },
      user,
      source: "profile",
    };
  }

  const login = await devLogin(origin, devLoginEmail);
  const user = await ensureOnboarded(origin, login.token, login.user);
  saveAuthProfile(origin, {
    accessToken: login.token,
    userId: user.id,
    email: user.email,
    name: user.name,
  });
  return {
    origin,
    token: login.token,
    headers: { Authorization: `Bearer ${login.token}` },
    user,
    source: "dev-login",
  };
}
