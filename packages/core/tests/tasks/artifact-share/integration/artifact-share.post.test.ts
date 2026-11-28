import { beforeAll, describe, expect } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { createArtifactShareHarness } from "./artifact-share-test-harness";

const outsider = (label: string) =>
  createTestUserAndSession({
    email: `${label}-${crypto.randomUUID()}@example.com`,
  });

describe("POST /projects/:projectId/artifact-bundles/:bundleId/share", () => {
  const { harness, shareApi, markBundle } = createArtifactShareHarness(
    "artifact-share-post",
  );

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest("refuses a bundle that is not ready", async () => {
    const { taskRunId, claimToken } =
      await harness.claimTaskRun("share-post-pending");
    const pending = await harness.createBundle(taskRunId, claimToken, {
      name: "pending",
      rootPath: "out/pending",
    });

    const { data, error } = await shareApi(pending.id).post(
      {},
      { headers: { ...harness.authHeaders } },
    );
    expect(data).toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "ARTIFACT_BUNDLE_NOT_READY" });
  });

  serialTest("refuses an expired bundle", async () => {
    const { bundleId } = await harness.createReadyBundle(
      "share-post-expired",
      "expired",
    );
    await markBundle(bundleId, { expiredAt: new Date() });

    const { error } = await shareApi(bundleId).post(
      {},
      { headers: { ...harness.authHeaders } },
    );
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "ARTIFACT_BUNDLE_EXPIRED" });
  });

  serialTest("returns 404 for a deleted or unknown bundle", async () => {
    const { bundleId } = await harness.createReadyBundle(
      "share-post-deleted",
      "deleted",
    );
    await markBundle(bundleId, { deletedAt: new Date() });
    const headers = { ...harness.authHeaders };

    const deleted = await shareApi(bundleId).post({}, { headers });
    expect(deleted.error?.status).toBe(404);
    const unknown = await shareApi(createUuidV7()).post({}, { headers });
    expect(unknown.error?.status).toBe(404);
  });

  serialTest("returns 404 for another project's bundle", async () => {
    const other = createArtifactShareHarness("artifact-share-post-other");
    await other.harness.setup();
    const { bundleId } =
      await other.harness.createReadyBundle("share-post-other");

    const { error } = await shareApi(bundleId).post(
      {},
      { headers: { ...harness.authHeaders } },
    );
    expect(error?.status).toBe(404);

    const status = await unwrapAsync(
      other
        .shareApi(bundleId)
        .get({ headers: { ...other.harness.authHeaders } }),
    );
    expect(status.status).toBe("private");
  });

  serialTest("refuses a non-member", async () => {
    const { bundleId } = await harness.createReadyBundle(
      "share-post-non-member",
      "non-member",
    );
    const stranger = await outsider("share-post-stranger");

    const post = await shareApi(bundleId).post(
      {},
      { headers: { ...stranger.authHeaders } },
    );
    expect(post.data).toBeNull();
    expect(post.error?.status).toBe(403);

    const get = await shareApi(bundleId).get({
      headers: { ...stranger.authHeaders },
    });
    expect(get.data).toBeNull();
    expect(get.error?.status).toBe(403);
  });
});

describe("POST share on a public project", () => {
  const { harness, shareApi, makeProjectPublic } = createArtifactShareHarness(
    "artifact-share-post-public",
  );

  beforeAll(async () => {
    await harness.setup();
    await makeProjectPublic();
  });

  serialTest(
    "refuses a public-project non-member, who also cannot see share info",
    async () => {
      const { bundleId } = await harness.createReadyBundle("share-post-public");
      const ownerShare = await unwrapAsync(
        shareApi(bundleId).post({}, { headers: { ...harness.authHeaders } }),
      );
      expect(ownerShare.status).toBe("shared");
      const stranger = await outsider("share-post-public-stranger");

      const post = await shareApi(bundleId).post(
        {},
        { headers: { ...stranger.authHeaders } },
      );
      expect(post.data).toBeNull();
      expect(post.error?.status).toBe(403);

      const get = await shareApi(bundleId).get({
        headers: { ...stranger.authHeaders },
      });
      expect(get.data).toBeNull();
      expect(get.error?.status).toBe(403);

      const anonymous = await shareApi(bundleId).get();
      expect(anonymous.data).toBeNull();
      expect(anonymous.error?.status).toBe(401);
    },
  );
});
