import path from "node:path";
import type { NextConfig } from "next";

// Resolve once at config-load time (i.e. at build time, before the bundler
// runs). Vercel sets VERCEL_ENV to "production", "preview", or "development"
// on its builds; it is undefined for non-Vercel builds (e.g. a contributor's
// laptop). We only want to *strip* dev login from the real production build,
// so the constant is "false" exclusively when VERCEL_ENV === "production".
//
// Important: this value is a string literal ("true" / "false"), not a boolean.
// Next.js inlines `env` entries by feeding them into webpack's DefinePlugin,
// which performs textual substitution on `process.env.<NAME>` references —
// boolean values would be coerced to "true"/"false" anyway, so we just use
// strings to make the substitution behaviour obvious at the call site.
//
// Self-hosted image builds set NEXT_OUTPUT=standalone (see apps/next/Dockerfile)
// and strip dev login the same way.
const standaloneOutput = process.env["NEXT_OUTPUT"] === "standalone";
const devLoginBuildEnabled =
  process.env["VERCEL_ENV"] === "production" || standaloneOutput
    ? "false"
    : "true";

const nextConfig: NextConfig = {
  // Standalone output traces from the repo root so workspace packages
  // (packages/*, apps/api) land in .next/standalone. Vercel builds leave it off.
  ...(standaloneOutput && {
    output: "standalone",
    outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  }),
  // @scarn/sdk ships compiled JS for non-Bun bundlers via the "import" condition, so it doesn't need transpiling
  transpilePackages: [
    "@scarn/identity",
    "@scarn/core",
    "@scarn/api",
  ],
  // The e2e runner sets E2E_SKIP_TYPECHECK=1: CI's `Lint & typecheck` job
  // already typechecks, and it's most of `next build`'s wall time.
  typescript: {
    ignoreBuildErrors: process.env["E2E_SKIP_TYPECHECK"] === "1",
  },
  outputFileTracingIncludes: {
    // The demo-project-refresh maintenance route (mounted on the catch-all
    // `/api/[[...slugs]]` route via `@scarn/api/app`) transitively calls
    // `refreshDemoProject` -> `seedDemoProject`, which reads real captured
    // fixture files (`.log.jsonl`/`.result.json`/screenshots/trace `.zip`s)
    // off disk at runtime from `packages/core/src/demo-project/fixtures/`
    // via dynamically-constructed paths (e.g.
    // `path.join(FIXTURES_DIR, \`${files.base}.log.jsonl\`)`). Next's file
    // tracer only follows statically-analyzable `require`/`import` calls, so
    // it cannot discover these reads on its own and would otherwise prune
    // them from the deployed Vercel function, causing `ENOENT` at runtime
    // even though the code itself is present and the local `next build`
    // succeeds. This forces them into the trace.
    "/api/**/*": ["../../packages/core/src/demo-project/fixtures/**/*"],
  },
  env: {
    // Build-time gate for the /api/dev/login route. The route file references
    // `process.env.DEV_LOGIN_BUILD_ENABLED`; Next.js (via DefinePlugin) rewrites
    // that reference to the string literal below during compilation. In prod
    // builds the literal is "false", so the route's guard collapses to a
    // statically-false branch and webpack dead-code-eliminates the entire
    // implementation (including the dynamically-imported handler chunk).
    //
    // Defence in depth: even if someone sets ENABLE_DEV_LOGIN=true in the prod
    // Vercel project, the dev-login code is no longer present in the prod
    // bundle to be invoked — so the runtime env-var gate is not the only thing
    // standing between prod and an impersonation endpoint.
    DEV_LOGIN_BUILD_ENABLED: devLoginBuildEnabled,
  },
};

export default nextConfig;
