import type { Argv } from "yargs";
import { resolveScarnBaseUrl } from "@scarn/worker";
import { connectApi, type AuthenticatedApi } from "./cli-api-client";
import { CliError } from "./cli-error";
import {
  NO_PROJECT_MESSAGE,
  pickProjectRef,
  resolveCliProjectRef,
  type ProjectAction,
} from "./resolve-project-ref";
import { syncIdentityFromDisk } from "./telemetry";

/**
 * The project every project-scoped command acts on: `--project owner/slug`,
 * falling back to `"project"` in `.scarn/scarn.jsonc`.
 */

export interface ProjectArguments {
  project: string | undefined;
  baseUrl: string | undefined;
}

/** Adds `--base-url`, for commands that need no project. */
export const withBaseUrlOption = <T>(argv: Argv<T>) =>
  argv.option("baseUrl", {
    alias: "base-url",
    type: "string",
    describe: "Scarn app base URL",
  });

/** Adds `--project` and `--base-url`. */
export const withProjectOptions = <T>(argv: Argv<T>) =>
  withBaseUrlOption(
    argv.option("project", {
      type: "string",
      describe:
        'The project, as owner/slug (defaults to "project" in .scarn/scarn.jsonc)',
    }),
  );

/** An authenticated client plus the resolved project id. */
export async function connectProject(
  args: ProjectArguments,
  action: ProjectAction,
): Promise<AuthenticatedApi & { baseUrl: string; projectId: string }> {
  const baseUrl = resolveScarnBaseUrl(args.baseUrl);
  const projectRef = await pickProjectRef(args.project);
  if (!projectRef) {
    throw new CliError("no_project_id", NO_PROJECT_MESSAGE);
  }
  const api = await connectApi(baseUrl);
  syncIdentityFromDisk(baseUrl);
  const { id: projectId } = await resolveCliProjectRef({
    baseUrl,
    ref: projectRef,
    action,
  });
  return { ...api, baseUrl, projectId };
}
