import {
  createDevLoginSession,
  DEV_LOGIN_DEFAULT_EMAIL,
  DevLoginInvalidEmailError,
  getDevLoginEnabled,
} from "@scarn/identity";

// The real implementation of POST /api/dev/login. Kept in a separate module so
// the route file (route.ts) can `await import()` it behind a build-time guard
// and webpack can drop this entire module — and its @scarn/identity import
// graph — from the production bundle via dead-code elimination.
//
// Anything imported here is, by extension, also part of the chunk that gets
// stripped. Keep this file lean so it's easy to reason about what is/isn't
// shipped in prod.
export async function handleDevLoginRequest(
  request: Request,
): Promise<Response> {
  // Runtime defence in depth: even on non-prod Vercel deploys (preview /
  // `vercel dev`) the dev-login endpoint is opt-in via ENABLE_DEV_LOGIN=true.
  // The build-time guard upstream already prevents this code from executing
  // in production builds at all.
  if (!getDevLoginEnabled()) {
    return new Response("Not found", { status: 404 });
  }

  let email: string = DEV_LOGIN_DEFAULT_EMAIL;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { email?: unknown };
      if (typeof body.email === "string" && body.email.trim().length > 0) {
        email = body.email;
      }
    }
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  let cookie;
  try {
    cookie = await createDevLoginSession(email);
  } catch (error) {
    if (error instanceof DevLoginInvalidEmailError) {
      return new Response("Invalid email", { status: 400 });
    }
    throw error;
  }

  const response = new Response(null, { status: 204 });
  response.headers.append(
    "set-cookie",
    [
      `${cookie.name}=${cookie.value}`,
      `Path=${cookie.path}`,
      cookie.domain ? `Domain=${cookie.domain}` : null,
      `Max-Age=${cookie.maxAge.toString()}`,
      `SameSite=${cookie.sameSite}`,
      cookie.httpOnly ? "HttpOnly" : null,
      cookie.secure ? "Secure" : null,
    ]
      .filter((part): part is string => part !== null)
      .join("; "),
  );

  return response;
}
