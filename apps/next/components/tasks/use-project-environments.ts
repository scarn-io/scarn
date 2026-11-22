"use client";

/**
 * Loaders for the start dialog's environment and connector fields: the
 * project's named environments, one environment's latest content, the
 * connector catalog and the project's saved secret names. Each one settles to
 * an empty value when its request fails, so the dialog still opens.
 */
import { useEffect, useState } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import type {
  CatalogConnector,
  EnvironmentFacts,
} from "./start-task-environment";

export type ProjectEnvironment = { name: string; description: string | null };

/** `load`'s result for the current `key`; `initial` until it settles, or when `load` is `null`. */
function useLoaded<T>(
  load: (() => Promise<T | null | undefined>) | null,
  initial: T,
  key: string,
): T {
  const [loaded, setLoaded] = useState<{ key: string; value: T } | null>(null);
  const hasLoader = load !== null;
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    void load()
      .catch(() => null)
      .then((value) => {
        if (!cancelled) setLoaded({ key, value: value ?? initial });
      });
    return () => {
      cancelled = true;
    };
  }, [key, hasLoader]);
  return hasLoader && loaded?.key === key ? loaded.value : initial;
}

const NO_ENVIRONMENTS: ProjectEnvironment[] = [];
const NO_CONNECTORS: CatalogConnector[] = [];
const NO_SECRETS: string[] = [];

/** The project's named environments, sorted by name. */
export function useProjectEnvironments(
  projectId: string,
): ProjectEnvironment[] {
  return useLoaded(
    async () => {
      const { data } = await getBrowserScarnApiClient()
        .api.projects({ projectId: parseUuidV7(projectId) })
        .environments.get();
      return Array.isArray(data)
        ? data
            .map(({ name, description }) => ({ name, description }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : null;
    },
    NO_ENVIRONMENTS,
    projectId,
  );
}

/** The latest content of the named environment; `null` while loading or when `name` is `null`. */
export function useEnvironmentFacts(
  projectId: string,
  name: string | null,
): EnvironmentFacts | null {
  return useLoaded<EnvironmentFacts | null>(
    name === null
      ? null
      : async () => {
          const { data } = await getBrowserScarnApiClient()
            .api.projects({ projectId: parseUuidV7(projectId) })
            .environments({ name })
            .get({ query: {} });
          return data ? data.version.content : null;
        },
    null,
    `${projectId}/${name ?? ""}`,
  );
}

/** The Scarn connector catalog. */
export function useConnectorCatalog(): CatalogConnector[] {
  return useLoaded(
    async () => {
      const { data } = await getBrowserScarnApiClient().api.connectors.get();
      return Array.isArray(data) ? data : null;
    },
    NO_CONNECTORS,
    "catalog",
  );
}

/** Names of the project's saved secrets. */
export function useProjectSecretNames(projectId: string): string[] {
  return useLoaded(
    async () => {
      const { data } = await getBrowserScarnApiClient()
        .api.projects({ projectId: parseUuidV7(projectId) })
        .secrets.get();
      return Array.isArray(data) ? data.map((secret) => secret.name) : null;
    },
    NO_SECRETS,
    projectId,
  );
}
