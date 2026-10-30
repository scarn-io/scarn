import path from "node:path";
import { createScarnClient } from "../client";
import { loadAuthProfile } from "./auth-file";
import { resolveScarnBaseUrl } from "./base-url";
import { loadProjectConfig } from "./project-config";
import { resolveProjectRef } from "./project-ref";

export interface PushDefaults {
  baseUrl: string;
  projectId: string | undefined;
  accessToken: string | undefined;
}

export interface LoadPushDefaultsOptions {
  /**
   * Directory the script is running from. The project config (`.scarn/scarn.jsonc`)
   * is searched for in this directory and each ancestor directory.
   */
  dir: string;
}

async function findProjectConfigUpwards(startDir: string) {
  let current = path.resolve(startDir);
  for (;;) {
    const found = await loadProjectConfig(current);
    if (found) return found;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Reads the conventional defaults for a `scarn pipelines push` run:
 * - `baseUrl`: from `SCARN_BASE_URL` env var or the built-in default.
 * - `accessToken`: from `SCARN_ACCESS_TOKEN` env var or the saved auth
 *   profile for the resolved `baseUrl`.
 * - `projectId`: from `SCARN_PROJECT_ID` env var (a project id, which
 *   `scarn pipelines push` sets after resolving the ref), or else the
 *   `"project"` ref in the nearest ancestor `.scarn/scarn.jsonc` of
 *   `opts.dir`, resolved against the server. Resolution needs `accessToken`;
 *   without one `projectId` is left undefined. A ref the server rejects throws
 *   a `ProjectRefError` naming the ref.
 */
export async function loadPushDefaults(
  opts: LoadPushDefaultsOptions,
): Promise<PushDefaults> {
  const baseUrl = resolveScarnBaseUrl();

  const envAccessToken = process.env["SCARN_ACCESS_TOKEN"]?.trim();
  const accessToken = envAccessToken
    ? envAccessToken
    : loadAuthProfile(baseUrl)?.accessToken;

  const envProjectId = process.env["SCARN_PROJECT_ID"]?.trim();
  if (envProjectId) {
    return { baseUrl, projectId: envProjectId, accessToken };
  }

  const config = await findProjectConfigUpwards(opts.dir);
  if (!config || !accessToken) {
    return { baseUrl, projectId: undefined, accessToken };
  }

  const resolved = await resolveProjectRef(
    createScarnClient(baseUrl),
    config.project,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      action: "push pipelines to",
    },
  );
  return { baseUrl, projectId: resolved.id, accessToken };
}
