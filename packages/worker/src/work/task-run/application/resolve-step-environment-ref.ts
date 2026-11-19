import type { createScarnClient } from "@scarn/sdk";
import type {
  EnvironmentRef,
  ResolvedEnvironmentRefInput,
  StoredEnvironmentContent,
} from "@scarn/sdk/environment";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import { ConfigurationError } from "../../../lib/errors";

/**
 * Turns a step definition's environment reference into what a dry-run launch
 * takes. A named ref has no content of its own, so a dry run launches the
 * environment's latest version, fetched from the API; a name the project does
 * not have launches as not found, which the launch reports as an environment
 * problem. Inline and repository-default refs pass through unchanged.
 */

/** A step as a dry run launches it: its ref with any named version fetched. */
export type DryRunLaunchStep = {
  environment: ResolvedEnvironmentRefInput;
  repo: RepoConfig;
};

export type LatestEnvironmentVersion = {
  version: number;
  content: StoredEnvironmentContent;
};

/** The latest version of environment `name`, or null when the project has none. */
export type FetchLatestEnvironment = (
  name: string,
) => Promise<LatestEnvironmentVersion | null>;

export async function resolveStepEnvironmentRef(
  ref: EnvironmentRef,
  fetchLatest: FetchLatestEnvironment,
): Promise<ResolvedEnvironmentRefInput> {
  if (ref?.kind !== "named") return ref;
  const latest = await fetchLatest(ref.name);
  return latest
    ? {
        kind: "named",
        name: ref.name,
        version: latest.version,
        content: latest.content,
      }
    : { kind: "named", name: ref.name, notFound: true };
}

/**
 * Fetches each environment's latest version from the API, once per name. A
 * 404 means the project has no such environment; any other failure throws,
 * as an unreadable step definition does.
 */
export function createLatestEnvironmentFetcher(
  client: ReturnType<typeof createScarnClient>,
  projectId: string,
): FetchLatestEnvironment {
  return fetchOncePerName((name) =>
    fetchLatestEnvironment(client, projectId, name),
  );
}

/** Shares one fetch between every step that names the same environment. */
export function fetchOncePerName(
  fetchLatest: FetchLatestEnvironment,
): FetchLatestEnvironment {
  const byName = new Map<string, Promise<LatestEnvironmentVersion | null>>();
  return (name) => {
    let pending = byName.get(name);
    if (!pending) {
      pending = fetchLatest(name);
      byName.set(name, pending);
    }
    return pending;
  };
}

async function fetchLatestEnvironment(
  client: ReturnType<typeof createScarnClient>,
  projectId: string,
  name: string,
): Promise<LatestEnvironmentVersion | null> {
  const result = await client.environments.getEnvironment({
    path: { projectId, name },
  });
  if (result.response.status === 404) return null;
  if (!result.data) {
    const detail = (result.error as { detail?: string }).detail;
    throw new ConfigurationError(
      `Could not fetch environment ${name}${detail ? `: ${detail}` : "."}`,
    );
  }
  return {
    version: result.data.version.version,
    content: result.data.version.content,
  };
}
