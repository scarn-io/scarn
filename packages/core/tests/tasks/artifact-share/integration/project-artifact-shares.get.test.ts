import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { createArtifactShareHarness } from "./artifact-share-test-harness";

describe("GET /projects/:projectId/artifact-shares", () => {
  const { harness, shareApi, markBundle, makeProjectPublic } =
    createArtifactShareHarness("project-artifact-shares-get");

  const sharesApi = (projectId: UuidV7 = harness.projectId) =>
    harness.apiClient.api.projects({ projectId })["artifact-shares"];

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest(
    "lists the project's active shares, newest first, without revoked or deleted ones",
    async () => {
      const headers = { ...harness.authHeaders };
      const first = await harness.createReadyBundle("shares-first", "first");
      const second = await harness.createReadyBundle("shares-second", "second");
      const revoked = await harness.createReadyBundle(
        "shares-revoked",
        "revoked",
      );
      const deleted = await harness.createReadyBundle(
        "shares-deleted",
        "deleted",
      );
      await harness.createReadyBundle("shares-private", "private");

      const firstShare = await unwrapAsync(
        shareApi(first.bundleId).post({}, { headers }),
      );
      const secondShare = await unwrapAsync(
        shareApi(second.bundleId).post({}, { headers }),
      );
      await unwrapAsync(shareApi(revoked.bundleId).post({}, { headers }));
      await unwrapAsync(shareApi(revoked.bundleId).delete({}, { headers }));
      await unwrapAsync(shareApi(deleted.bundleId).post({}, { headers }));
      await markBundle(deleted.bundleId, { deletedAt: new Date() });

      const other = createArtifactShareHarness("project-artifact-shares-other");
      await other.harness.setup();
      const otherBundle = await other.harness.createReadyBundle("shares-other");
      await unwrapAsync(
        other
          .shareApi(otherBundle.bundleId)
          .post({}, { headers: { ...other.harness.authHeaders } }),
      );

      const list = await unwrapAsync(sharesApi().get({ headers }));
      expect(list.hasMore).toBe(false);
      expect(list.shares.map((share) => share.bundleId)).toEqual([
        second.bundleId,
        first.bundleId,
      ]);
      expect(list.shares[0]).toEqual({
        id: secondShare.share?.id as UuidV7,
        bundleId: second.bundleId,
        bundleName: "second",
        taskRunId: second.taskRunId,
        status: "shared",
        url: secondShare.url,
        createdVia: "person",
        createdAt: secondShare.share?.createdAt as string,
        expiresAt: secondShare.expiresAt,
      });
      expect(list.shares[1]?.url).toBe(firstShare.url);
    },
  );

  serialTest("reports an expired bundle's share without a link", async () => {
    const headers = { ...harness.authHeaders };
    const expiring = await harness.createReadyBundle(
      "shares-expired",
      "expired",
    );
    await unwrapAsync(shareApi(expiring.bundleId).post({}, { headers }));
    await markBundle(expiring.bundleId, { expiredAt: new Date() });

    const list = await unwrapAsync(sharesApi().get({ headers }));
    expect(
      list.shares.find((share) => share.bundleId === expiring.bundleId),
    ).toMatchObject({ status: "expired", url: null });
  });

  serialTest("refuses non-members, even on a public project", async () => {
    const stranger = await createTestUserAndSession({
      email: `shares-stranger-${crypto.randomUUID()}@example.com`,
    });

    const privateList = await sharesApi().get({
      headers: { ...stranger.authHeaders },
    });
    expect(privateList.error?.status).toBe(403);

    await makeProjectPublic();
    const publicList = await sharesApi().get({
      headers: { ...stranger.authHeaders },
    });
    expect(publicList.data).toBeNull();
    expect(publicList.error?.status).toBe(403);
  });
});
