import { beforeAll, describe, expect } from "bun:test";
import { serialTest, unwrapAsync } from "tests/utils";
import { createArtifactBundleHarness } from "./artifact-bundle-test-harness";

describe("artifact bundle lifecycle", () => {
  const harness = createArtifactBundleHarness("artifact-bundle-lifecycle");
  const { apiClient } = harness;

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest(
    "creates a bundle, uploads its members, finalizes it and lists it ready",
    async () => {
      const { taskRunId, claimToken } = await harness.claimTaskRun(
        "worker-bundle-lifecycle",
      );
      const taskRun = apiClient.api["task-runs"]({ taskRunId });
      const headers = { ...harness.authHeaders };

      const created = await unwrapAsync(
        taskRun["artifact-bundles"].post(
          {
            claimToken,
            name: "report",
            rootPath: "./out/report/",
            entryPath: "index.html",
          },
          { headers },
        ),
      );
      expect(created).toMatchObject({
        taskRunId,
        projectId: harness.projectId,
        name: "report",
        rootPath: "out/report",
        entryPath: "index.html",
        status: "pending",
        fileCount: null,
        sizeBytes: null,
        finalizedAt: null,
      });

      const entry = await harness.uploadMember({
        taskRunId,
        claimToken,
        bundleId: created.id,
        relativeStorePath: "out/report/index.html",
        sizeBytes: 120,
      });
      expect(entry.relativeStorePath).toBe("out/report/index.html");
      await harness.uploadMember({
        taskRunId,
        claimToken,
        bundleId: created.id,
        relativeStorePath: "out/report/assets/app.js",
        sizeBytes: 80,
      });

      const finalized = await unwrapAsync(
        taskRun["artifact-bundles"]({ bundleId: created.id }).finalize.post(
          {
            claimToken,
            manifest: [
              { path: "index.html", sizeBytes: 120 },
              { path: "assets/app.js", sizeBytes: 80 },
            ],
          },
          { headers },
        ),
      );
      expect(finalized).toMatchObject({
        id: created.id,
        status: "ready",
        fileCount: 2,
        sizeBytes: 200,
      });
      expect(finalized.finalizedAt).not.toBeNull();

      const bundles = await unwrapAsync(
        taskRun["artifact-bundles"].get({ headers }),
      );
      expect(bundles).toHaveLength(1);
      expect(bundles[0]).toMatchObject({ id: created.id, status: "ready" });

      const single = await unwrapAsync(
        taskRun["artifact-bundles"]({ bundleId: created.id }).get({ headers }),
      );
      expect(single).toMatchObject({ id: created.id, status: "ready" });

      const repeated = await unwrapAsync(
        taskRun["artifact-bundles"]({ bundleId: created.id }).finalize.post(
          {
            claimToken,
            manifest: [
              { path: "assets/app.js", sizeBytes: 80 },
              { path: "index.html", sizeBytes: 120 },
            ],
          },
          { headers },
        ),
      );
      expect(repeated).toEqual(finalized);

      expect(Date.parse(single.expiresAt)).toBe(
        Date.parse(created.createdAt) + 30 * 24 * 60 * 60 * 1_000,
      );
      expect(single.expired).toBe(false);

      const artifacts = await unwrapAsync(taskRun.artifacts.get({ headers }));
      expect(
        artifacts.map((artifact) => artifact.relativeStorePath).sort(),
      ).toEqual(["out/report/assets/app.js", "out/report/index.html"]);
      expect(
        artifacts.every((artifact) => artifact.bundleId === created.id),
      ).toBe(true);

      const projectList = await unwrapAsync(
        apiClient.api
          .projects({ projectId: harness.projectId })
          .artifacts.get({ headers }),
      );
      const listedMembers = projectList.artifacts.filter(
        (artifact) => artifact.taskRunId === taskRunId,
      );
      expect(listedMembers).toHaveLength(2);
      expect(listedMembers.map((artifact) => artifact.bundleId)).toEqual([
        created.id,
        created.id,
      ]);
      expect(
        projectList.bundles.find((bundle) => bundle.id === created.id),
      ).toMatchObject({ id: created.id, status: "ready" });
    },
  );
});
