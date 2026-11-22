// Local-only endpoint that opens a session for an arbitrary user by email so
// contributors can sign in without OAuth and impersonate any user in their
// dev database. Two independent layers gate access:
//
//   1. Build-time: `process.env.DEV_LOGIN_BUILD_ENABLED` is inlined as a
//      string literal by Next.js's DefinePlugin (configured in next.config.ts).
//      The value is "false" only when the build is happening with
//      VERCEL_ENV === "production"; every other build (local, CI, Vercel
//      preview) gets "true". On a prod build the `if` below collapses to
//      `if ("false" === "true")`, the body becomes unreachable, and webpack
//      dead-code-eliminates the entire branch — including the dynamic import
//      of ./handler. The handler module (and its @scarn/identity dependency
//      graph) is therefore never emitted to the prod bundle. Even if every
//      runtime env-var check were bypassed, there is nothing in production to
//      run.
//
//   2. Runtime: when the code DOES exist (local / preview), the handler still
//      requires ENABLE_DEV_LOGIN=true and refuses if VERCEL_ENV === "production".
//      See `getDevLoginEnabled()` in @scarn/identity.
//
// The dynamic `await import()` is load-bearing: a top-level static import
// would keep @scarn/identity in the prod bundle regardless of how the
// branch below collapses, because the package isn't flagged side-effect-free.
export async function POST(request: Request): Promise<Response> {
  if (process.env["DEV_LOGIN_BUILD_ENABLED"] === "true") {
    const { handleDevLoginRequest } = await import("./handler");
    return handleDevLoginRequest(request);
  }

  return new Response("Not found", { status: 404 });
}
