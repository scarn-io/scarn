/**
 * Whether this deployment advertises the seeded demo project in the UI
 * (`SCARN_DEMO_PROJECT=true` or `1`). Off by default so self-hosted installs
 * without a seeded demo don't link to a missing project. Read on the server at
 * request time, so a standalone build can change it without a rebuild.
 */
export const isDemoProjectEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const raw = env["SCARN_DEMO_PROJECT"]?.trim().toLowerCase();
  return raw === "true" || raw === "1";
};
