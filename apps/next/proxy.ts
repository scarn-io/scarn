import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { REQUEST_PATH_HEADER } from "@/app/_lib/callback-url";

// Server Component layouts (e.g. `(protected)/layout.tsx`,
// `[username]/[projectSlug]/layout.tsx`) only receive their own dynamic
// segment `params`, not the full requested path or query string — Next has no
// built-in way to read that in a layout. This proxy stamps the raw pathname +
// search onto a request header so those layouts can build a `callbackUrl`
// (see `getCurrentRequestPath` in `_lib/callback-url.ts`) and send
// unauthenticated/un-onboarded users back to where they started after
// login/onboarding, instead of always landing on a default page.
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    REQUEST_PATH_HEADER,
    request.nextUrl.pathname + request.nextUrl.search,
  );

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  // Skip API routes (including Better Auth's own `/api/auth/*`, mounted via
  // the catch-all in `app/api/[[...slugs]]`) and static assets — only page
  // navigations need the captured path.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
