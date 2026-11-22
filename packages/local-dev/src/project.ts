/**
 * Finds the `acme-sandbox` project whose `gitUrl` is the local bare repo, or
 * creates it. The `gitUrl` is a plain absolute path: the API accepts absolute
 * paths, and the worker clones them directly (its mirror cache keys them as
 * `file://<path>`).
 */
import { createScarnClient } from "@scarn/sdk";
import type { LocalDevAuth } from "./auth";

export interface LocalDevProject {
  id: string;
  /** `owner/slug`, as `.scarn/scarn.jsonc` stores it. */
  ref: string;
  created: boolean;
}

interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  gitUrl: string;
  ownerUsername: unknown;
}

function unwrap<T>(
  result: { data?: T; error?: unknown; response?: Response },
  context: string,
): T {
  if (result.error !== undefined) {
    const status = result.response
      ? ` (${String(result.response.status)})`
      : "";
    throw new Error(
      `[local-dev] ${context} failed${status}: ${JSON.stringify(result.error)}`,
    );
  }
  if (result.data === undefined) {
    throw new Error(`[local-dev] ${context} returned no data`);
  }
  return result.data;
}

function toLocalDevProject(
  project: ProjectSummary,
  created: boolean,
): LocalDevProject {
  if (typeof project.ownerUsername !== "string" || !project.ownerUsername) {
    throw new Error(
      `[local-dev] project ${project.slug} has no owner username. Finish onboarding first.`,
    );
  }
  return {
    id: project.id,
    ref: `${project.ownerUsername}/${project.slug}`,
    created,
  };
}

export async function ensureProject(input: {
  auth: LocalDevAuth;
  name: string;
  gitUrl: string;
}): Promise<LocalDevProject> {
  const { auth, name, gitUrl } = input;
  const api = createScarnClient(auth.origin);
  const findExisting = async (): Promise<ProjectSummary | undefined> => {
    const projects: ProjectSummary[] = unwrap(
      await api.projects.listProjects({ headers: auth.headers }),
      "listProjects",
    );
    return projects.find(
      (project) => project.name === name && project.gitUrl === gitUrl,
    );
  };

  const existing = await findExisting();
  if (existing) return toLocalDevProject(existing, false);

  const created: ProjectSummary = unwrap(
    await api.projects.createProject({
      body: {
        name,
        description: "Local sandbox seeded by @scarn/local-dev.",
        gitUrl,
        origin: "cli_api",
      },
      headers: auth.headers,
    }),
    "createProject",
  );
  const listed = await findExisting();
  if (listed?.id !== created.id) {
    throw new Error(
      `[local-dev] created project ${created.id} is missing from listProjects`,
    );
  }
  return toLocalDevProject(listed, true);
}
