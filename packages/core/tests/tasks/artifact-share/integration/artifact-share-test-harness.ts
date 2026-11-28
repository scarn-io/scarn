import { eq } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projects, taskArtifactBundles } from "@/lib/db/schema";
import {
  createArtifactSharingConfig,
  type ArtifactSharingConfig,
} from "@/tasks/artifact-share/domain/artifact-sharing-config";
import type { ContentRateLimiter } from "@/tasks/artifact-share/application/content-rate-limiter";
import { createArtifactBundleHarness } from "tests/tasks/task-artifact/integration/artifact-bundle-test-harness";

export const TEST_SHARING_CONFIG = createArtifactSharingConfig({
  contentUrl: "https://content.example.test/",
  shareSecret: "test-artifact-share-secret",
});

/**
 * The artifact-bundle harness with sharing configured, plus helpers to reach
 * a bundle's share routes and to age, delete or publish rows directly.
 */
export const createArtifactShareHarness = (
  label: string,
  artifactSharingConfig: ArtifactSharingConfig = TEST_SHARING_CONFIG,
  options: { contentRateLimiter?: ContentRateLimiter } = {},
) => {
  const harness = createArtifactBundleHarness(label, {
    artifactSharingConfig,
    ...options,
  });

  const shareApi = (bundleId: UuidV7, projectId: UuidV7 = harness.projectId) =>
    harness.apiClient.api
      .projects({ projectId })
      ["artifact-bundles"]({ bundleId }).share;

  const markBundle = async (
    bundleId: UuidV7,
    values: { expiredAt?: Date; deletedAt?: Date },
  ) => {
    await getDb()
      .update(taskArtifactBundles)
      .set(values)
      .where(eq(taskArtifactBundles.id, bundleId));
  };

  const makeProjectPublic = async () => {
    await getDb()
      .update(projects)
      .set({ visibility: "public" })
      .where(eq(projects.id, harness.projectId));
  };

  const resolveDeps = () => ({
    artifactShareRepo: harness.appContext.artifactShareRepo,
    artifactBundleRepo: harness.appContext.artifactBundleRepo,
    artifactSharingConfig: harness.appContext.artifactSharingConfig,
    taskRunRepo: harness.appContext.taskRunRepo,
    timeProvider: harness.appContext.timeProvider,
  });

  return { harness, shareApi, markBundle, makeProjectPublic, resolveDeps };
};

/** The token in a share URL (`<contentUrl>/s/<token>/`). */
export const tokenFromShareUrl = (url: string | null): string => {
  const match = /\/s\/([^/]+)\/$/.exec(url ?? "");
  const token = match?.[1];
  if (!token) {
    throw new Error(`Expected a share URL, got ${String(url)}`);
  }
  return token;
};
