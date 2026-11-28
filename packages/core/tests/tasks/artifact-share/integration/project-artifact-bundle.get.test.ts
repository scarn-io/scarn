import { beforeAll, describe, expect } from "bun:test";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { createArtifactShareHarness } from "./artifact-share-test-harness";

const outsider = (label: string) =>
  createTestUserAndSession({
    email: `${label}-${crypto.randomUUID()}@example.com`,
  });

describe("GET /projects/:projectId/artifact-bundles/:bundleId", () => {
  const { harness, markBundle, makeProjectPublic } = createArtifactShareHarness(
    "project-artifact-bundle-get",
  );

  const bundleApi = (bundleId: UuidV7, projectId: UuidV7 = harness.projectId) =>
    harness.apiClient.api
      .projects({ projectId })
      ["artifact-bundles"]({ bundleId });

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest("returns the bundle with its member files", async () => {
    const { taskRunId, bundleId } =
      await harness.createReadyBundle("project-bundle-get");

    const bundle = await unwrapAsync(
      bundleApi(bundleId).get({ headers: { ...harness.authHeaders } }),
    );
    expect(bundle).toMatchObject({
      id: bundleId,
      taskRunId,
      projectId: harness.projectId,
      name: "report",
      status: "ready",
      fileCount: 1,
      sizeBytes: 100,
      expired: false,
      deleted: false,
    });
    expect(bundle.members).toHaveLength(1);
    expect(bundle.members[0]).toMatchObject({
      relativeStorePath: "out/report/index.html",
      bundleId,
      sizeBytes: 100,
    });
  });

  serialTest("reports a deleted bundle without members", async () => {
    const { bundleId } = await harness.createReadyBundle(
      "project-bundle-get-deleted",
      "deleted",
    );
    await markBundle(bundleId, { deletedAt: new Date() });

    const bundle = await unwrapAsync(
      bundleApi(bundleId).get({ headers: { ...harness.authHeaders } }),
    );
    expect(bundle).toMatchObject({ id: bundleId, deleted: true, members: [] });
  });

  serialTest(
    "returns 404 for an unknown or another project's bundle",
    async () => {
      const headers = { ...harness.authHeaders };
      const unknown = await bundleApi(createUuidV7()).get({ headers });
      expect(unknown.error?.status).toBe(404);

      const other = createArtifactShareHarness("project-artifact-bundle-other");
      await other.harness.setup();
      const { bundleId } = await other.harness.createReadyBundle(
        "project-bundle-get-other",
      );
      const crossProject = await bundleApi(bundleId).get({ headers });
      expect(crossProject.error?.status).toBe(404);
    },
  );

  serialTest("refuses non-members, even on a public project", async () => {
    const { bundleId } = await harness.createReadyBundle(
      "project-bundle-get-stranger",
      "stranger",
    );
    const stranger = await outsider("project-bundle-get-stranger");

    const privateGet = await bundleApi(bundleId).get({
      headers: { ...stranger.authHeaders },
    });
    expect(privateGet.data).toBeNull();
    expect(privateGet.error?.status).toBe(403);

    await makeProjectPublic();
    const publicGet = await bundleApi(bundleId).get({
      headers: { ...stranger.authHeaders },
    });
    expect(publicGet.data).toBeNull();
    expect(publicGet.error?.status).toBe(403);
  });
});
