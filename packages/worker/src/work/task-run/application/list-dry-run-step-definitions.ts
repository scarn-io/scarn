import { ConfigurationError } from "../../../lib/errors";
import { resolveScarnBaseUrl } from "../../../auth/session/infra/auth-config";
import { loadAuthenticatedSession } from "../../../auth/session/application/load-authenticated-session";
import { createAuthenticatedScarnClient } from "../../../auth/session/infra/authenticated-scarn-client";

/** The project's step definitions a `work --dry-run` picker offers, one per key. */
export async function listProjectStepDefinitionsForDryRun(input: {
  projectId: string;
  baseUrl?: string | undefined;
}): Promise<Array<{ id: string; key: string; name: string }>> {
  const baseUrl = resolveScarnBaseUrl(input.baseUrl);
  const authenticated = await loadAuthenticatedSession(baseUrl);
  if (!authenticated) {
    throw new ConfigurationError(`Not signed in to ${baseUrl}.`);
  }
  const client = createAuthenticatedScarnClient(
    baseUrl,
    authenticated.profile.accessToken,
  );
  const result = await client.stepDefinitions.listStepDefinitions({
    query: { projectId: input.projectId },
  });
  const steps = (result.data ?? []) as Array<{
    id: string;
    key: string;
    name: string;
    version: number;
  }>;

  // Dedupe to the latest version per key, matching `pullPipelineDefinitions`'s
  // convention — the picker should offer one entry per step, not one per
  // historical version.
  const latestByKey = new Map<string, (typeof steps)[number]>();
  for (const step of steps) {
    const existing = latestByKey.get(step.key);
    if (!existing || step.version > existing.version) {
      latestByKey.set(step.key, step);
    }
  }
  return [...latestByKey.values()].map(({ id, key, name }) => ({
    id,
    key,
    name,
  }));
}
