/**
 * What a project loop started from a repo checkout works on: the project
 * (positional ref or `"project"` in `.scarn/scarn.jsonc`, resolved against
 * the server) and the repo directory whose `.scarn/.env` it reads.
 */
import { resolveScarnBaseUrl } from "@scarn/worker";
import { CliError } from "./cli-error";
import {
  NO_PROJECT_MESSAGE,
  pickProjectRef,
  PROJECT_ACTIONS,
  resolveCliProjectRef,
} from "./resolve-project-ref";

export type WorkTarget = {
  baseUrl: string;
  projectRef: string;
  projectId: string;
  repoDir: string;
};

export type ResolveWorkTargetInput = {
  project?: string | undefined;
  baseUrl?: string | undefined;
  cwd?: string | undefined;
};

/**
 * Resolves the work target from `cwd` (default `process.cwd()`). Throws a
 * {@link CliError} with `no_project_id` when no project is named, and the
 * project lookup's error when the ref does not resolve.
 */
export async function resolveWorkTarget(
  input: ResolveWorkTargetInput,
): Promise<WorkTarget> {
  const repoDir = input.cwd ?? process.cwd();
  const baseUrl = resolveScarnBaseUrl(input.baseUrl);
  const projectRef = await pickProjectRef(input.project, repoDir);
  if (!projectRef) throw new CliError("no_project_id", NO_PROJECT_MESSAGE);
  const { id: projectId } = await resolveCliProjectRef({
    baseUrl,
    ref: projectRef,
    action: PROJECT_ACTIONS.work,
  });
  return { baseUrl, projectRef, projectId, repoDir };
}
