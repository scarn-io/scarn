import { expect } from "bun:test";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { unwrapAsync } from "tests/utils";
import {
  createArtifactSharingConfig,
  type ArtifactSharingConfig,
} from "@/tasks/artifact-share/domain/artifact-sharing-config";
import type { ArtifactShareServedDomainEvent } from "@/tasks/artifact-share/domain/artifact-share-served.domain-event";
import type { ContentRateLimiter } from "@/tasks/artifact-share/application/content-rate-limiter";
import { ARTIFACT_SHARE_SERVED_DOMAIN_EVENT_TYPE } from "@/tasks/artifact-share/domain/artifact-share-served.domain-event";
import {
  createArtifactShareHarness,
  tokenFromShareUrl,
} from "./artifact-share-test-harness";

export const CONTENT_ORIGIN = "https://content.example.test";
export const API_ORIGIN = "https://api.example.test";

export const CONTENT_SHARING_CONFIG = createArtifactSharingConfig({
  contentUrl: CONTENT_ORIGIN,
  shareSecret: "test-artifact-share-secret",
});

/** The files every content-test bundle holds, keyed by bundle-relative path. */
export const BUNDLE_FILES: Record<
  string,
  { body: string; contentType?: string }
> = {
  "index.html": {
    body: "<!doctype html><title>Report</title><script src=assets/app.js></script>",
    contentType: "text/html",
  },
  "assets/app.js": {
    body: "console.log('report');",
    contentType: "application/javascript",
  },
  "media/clip.mp4": { body: "0123456789abcdefghij", contentType: "video/mp4" },
  "data/blob.unknownext": { body: "opaque-bytes" },
  "docs/a b.txt": { body: "spaced name" },
};

/**
 * The artifact-share harness plus a bundle whose members hold real bytes in
 * the in-memory object store, a recorder for `ArtifactShareServedDomainEvent`
 * and raw-request helpers for the content origin.
 */
export const createArtifactContentHarness = (
  label: string,
  config: ArtifactSharingConfig = CONTENT_SHARING_CONFIG,
  options: { contentRateLimiter?: ContentRateLimiter } = {},
) => {
  const share = createArtifactShareHarness(label, config, options);
  const { harness } = share;
  const app = harness.appContext;
  const served: ArtifactShareServedDomainEvent[] = [];
  app.domainEventDispatcher.register<ArtifactShareServedDomainEvent>(
    ARTIFACT_SHARE_SERVED_DOMAIN_EVENT_TYPE,
    {
      handle: (event) => {
        served.push(event);
        return Promise.resolve();
      },
    },
  );

  /** Create a `ready` bundle holding {@link BUNDLE_FILES}, with stored bytes. */
  const createContentBundle = async (
    workerId: string,
  ): Promise<{ taskRunId: UuidV7; bundleId: UuidV7 }> => {
    const { taskRunId, claimToken } = await harness.claimTaskRun(workerId);
    const bundle = await harness.createBundle(taskRunId, claimToken, {
      name: "site",
      rootPath: "out/site",
    });
    const taskRun = harness.taskRunApi(taskRunId);
    for (const [path, file] of Object.entries(BUNDLE_FILES)) {
      const relativeStorePath = `out/site/${path}`;
      const objectKey = `artifacts/${harness.projectId}/${taskRunId}/${relativeStorePath}`;
      const bytes = new TextEncoder().encode(file.body);
      await app.objectStore?.putObject({
        key: objectKey,
        body: bytes,
        contentType: file.contentType,
      });
      await unwrapAsync(
        taskRun.artifacts.post(
          {
            claimToken,
            objectKey,
            relativeStorePath,
            sizeBytes: bytes.byteLength,
            bundleId: bundle.id,
            ...(file.contentType ? { contentType: file.contentType } : {}),
          },
          { headers: { ...harness.authHeaders } },
        ),
      );
    }
    await unwrapAsync(
      harness.finalize(
        taskRunId,
        bundle.id,
        claimToken,
        Object.entries(BUNDLE_FILES).map(([path, file]) => ({
          path,
          sizeBytes: new TextEncoder().encode(file.body).byteLength,
        })),
      ),
    );
    return { taskRunId, bundleId: bundle.id };
  };

  /** Share a bundle and return its token. */
  const shareBundle = async (bundleId: UuidV7): Promise<string> => {
    const shared = await unwrapAsync(
      share
        .shareApi(bundleId)
        .post({}, { headers: { ...harness.authHeaders } }),
    );
    return tokenFromShareUrl(shared.url);
  };

  /** A raw request through the whole app (`createApp`), as an entry would send it. */
  const request = (url: string, init: RequestInit = {}) =>
    harness.app.handle(new Request(url, { redirect: "manual", ...init }));

  return {
    ...share,
    served,
    createContentBundle,
    shareBundle,
    request,
  };
};

export const expectNotFoundPage = async (response: Response) => {
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toContain("Link not available");
};
