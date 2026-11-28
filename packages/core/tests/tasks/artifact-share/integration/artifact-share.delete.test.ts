import { beforeAll, describe, expect } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { resolveShareToken } from "@/tasks/artifact-share/application/resolve-share-token";
import {
  createArtifactShareHarness,
  tokenFromShareUrl,
} from "./artifact-share-test-harness";

const outsider = (label: string) =>
  createTestUserAndSession({
    email: `${label}-${crypto.randomUUID()}@example.com`,
  });

describe("DELETE /projects/:projectId/artifact-bundles/:bundleId/share", () => {
  const { harness, shareApi, markBundle, resolveDeps } =
    createArtifactShareHarness("artifact-share-delete");

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest("is idempotent on a bundle with no active share", async () => {
    const { bundleId } = await harness.createReadyBundle(
      "share-delete-idempotent",
      "idempotent",
    );
    const headers = { ...harness.authHeaders };

    const first = await unwrapAsync(shareApi(bundleId).delete({}, { headers }));
    expect(first).toMatchObject({ status: "private", share: null });
    const second = await unwrapAsync(
      shareApi(bundleId).delete({}, { headers }),
    );
    expect(second).toEqual(first);
  });

  serialTest("revokes the link of an expired bundle", async () => {
    const { bundleId } = await harness.createReadyBundle(
      "share-delete-expired",
      "expired",
    );
    const headers = { ...harness.authHeaders };
    const shared = await unwrapAsync(shareApi(bundleId).post({}, { headers }));
    await markBundle(bundleId, { expiredAt: new Date() });

    const revoked = await unwrapAsync(
      shareApi(bundleId).delete({}, { headers }),
    );
    expect(revoked).toMatchObject({ status: "expired", share: null });
    expect(
      await resolveShareToken(tokenFromShareUrl(shared.url), resolveDeps()),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  serialTest("returns 404 for an unknown bundle", async () => {
    const { error } = await shareApi(createUuidV7()).delete(
      {},
      { headers: { ...harness.authHeaders } },
    );
    expect(error?.status).toBe(404);
  });

  serialTest("refuses a non-member and leaves the share active", async () => {
    const { bundleId } = await harness.createReadyBundle(
      "share-delete-non-member",
      "non-member",
    );
    const shared = await unwrapAsync(
      shareApi(bundleId).post({}, { headers: { ...harness.authHeaders } }),
    );
    const stranger = await outsider("share-delete-stranger");

    const { data, error } = await shareApi(bundleId).delete(
      {},
      { headers: { ...stranger.authHeaders } },
    );
    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    const resolved = await resolveShareToken(
      tokenFromShareUrl(shared.url),
      resolveDeps(),
    );
    expect(resolved.ok).toBe(true);
  });
});

describe("DELETE share on a public project", () => {
  const { harness, shareApi, makeProjectPublic, resolveDeps } =
    createArtifactShareHarness("artifact-share-delete-public");

  beforeAll(async () => {
    await harness.setup();
    await makeProjectPublic();
  });

  serialTest("refuses a public-project non-member", async () => {
    const { bundleId } = await harness.createReadyBundle("share-delete-public");
    const shared = await unwrapAsync(
      shareApi(bundleId).post({}, { headers: { ...harness.authHeaders } }),
    );
    const stranger = await outsider("share-delete-public-stranger");

    const { data, error } = await shareApi(bundleId).delete(
      {},
      { headers: { ...stranger.authHeaders } },
    );
    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    const resolved = await resolveShareToken(
      tokenFromShareUrl(shared.url),
      resolveDeps(),
    );
    expect(resolved.ok).toBe(true);
  });
});
