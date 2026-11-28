import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createArtifactBundleHarness } from "./artifact-bundle-test-harness";

const MIB = 1024 * 1024;

describe("artifact bundle finalize endpoint", () => {
  const harness = createArtifactBundleHarness("artifact-bundle-finalize");
  const { taskRunApi, createBundle, finalize, recordMember } = harness;

  beforeAll(async () => {
    await harness.setup();
  });

  describe("finalize", () => {
    concurrentTest(
      "rejects a missing member and leaves the bundle pending for a retry",
      async () => {
        const { taskRunId, claimToken } = await harness.claimTaskRun(
          "bundle-missing-member",
        );
        const bundle = await createBundle(taskRunId, claimToken);
        await harness.uploadMember({
          taskRunId,
          claimToken,
          bundleId: bundle.id,
          relativeStorePath: "out/report/index.html",
        });

        const { error } = await finalize(taskRunId, bundle.id, claimToken, [
          { path: "index.html" },
          { path: "app.js" },
        ]);
        expect(error?.status).toBe(422);
        expect(error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_MEMBER_MISSING",
        });

        const pending = await unwrapAsync(
          taskRunApi(taskRunId)
            ["artifact-bundles"]({ bundleId: bundle.id })
            .get({ headers: { ...harness.authHeaders } }),
        );
        expect(pending.status).toBe("pending");

        await harness.uploadMember({
          taskRunId,
          claimToken,
          bundleId: bundle.id,
          relativeStorePath: "out/report/app.js",
        });
        const ready = await unwrapAsync(
          finalize(taskRunId, bundle.id, claimToken, [
            { path: "index.html" },
            { path: "app.js" },
          ]),
        );
        expect(ready.status).toBe("ready");
      },
    );

    concurrentTest(
      "rejects a manifest size that differs from the recorded member",
      async () => {
        const { taskRunId, claimToken } = await harness.claimTaskRun(
          "bundle-size-mismatch",
        );
        const bundle = await createBundle(taskRunId, claimToken);
        await harness.uploadMember({
          taskRunId,
          claimToken,
          bundleId: bundle.id,
          relativeStorePath: "out/report/index.html",
        });

        const { error } = await finalize(taskRunId, bundle.id, claimToken, [
          { path: "index.html", sizeBytes: 99 },
        ]);
        expect(error?.status).toBe(422);
        expect(error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_MEMBER_SIZE_MISMATCH",
        });
      },
    );

    concurrentTest("rejects a member missing from the manifest", async () => {
      const { taskRunId, claimToken } = await harness.claimTaskRun(
        "bundle-extra-member",
      );
      const bundle = await createBundle(taskRunId, claimToken);
      for (const path of ["index.html", "stray.css"]) {
        await harness.uploadMember({
          taskRunId,
          claimToken,
          bundleId: bundle.id,
          relativeStorePath: `out/report/${path}`,
        });
      }

      const { error } = await finalize(taskRunId, bundle.id, claimToken, [
        { path: "index.html" },
      ]);
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "ARTIFACT_BUNDLE_MEMBER_UNEXPECTED",
      });
    });

    concurrentTest("rejects a manifest without the entry page", async () => {
      const { taskRunId, claimToken } = await harness.claimTaskRun(
        "bundle-missing-entry",
      );
      const bundle = await createBundle(taskRunId, claimToken);
      await harness.uploadMember({
        taskRunId,
        claimToken,
        bundleId: bundle.id,
        relativeStorePath: "out/report/other.html",
      });

      const { error } = await finalize(taskRunId, bundle.id, claimToken, [
        { path: "other.html" },
      ]);
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "ARTIFACT_BUNDLE_ENTRY_MISSING",
      });
    });

    concurrentTest("rejects a bundle over the total size limit", async () => {
      const { taskRunId, claimToken } =
        await harness.claimTaskRun("bundle-too-large");
      const bundle = await createBundle(taskRunId, claimToken);
      const paths = ["index.html", "a.bin", "b.bin"];
      for (const path of paths) {
        await unwrapAsync(
          recordMember({
            taskRunId,
            claimToken,
            bundleId: bundle.id,
            relativeStorePath: `out/report/${path}`,
            sizeBytes: 90 * MIB,
          }),
        );
      }

      const { error } = await finalize(
        taskRunId,
        bundle.id,
        claimToken,
        paths.map((path) => ({ path, sizeBytes: 90 * MIB })),
      );
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({ code: "ARTIFACT_BUNDLE_TOO_LARGE" });
    });

    concurrentTest("returns 409 when the claim token is wrong", async () => {
      const { taskRunId, claimToken } = await harness.claimTaskRun(
        "bundle-finalize-bad-claim",
      );
      const bundle = await createBundle(taskRunId, claimToken);
      const { error } = await finalize(
        taskRunId,
        bundle.id,
        "not-the-claim-token",
        [{ path: "index.html" }],
      );
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({
        code: "TASK_OWNERSHIP_CONFLICT",
      });
    });
  });
});

describe("artifact bundle limits from the app context", () => {
  const harness = createArtifactBundleHarness("artifact-bundle-limits", {
    artifactBundleLimits: { maxFiles: 2, maxFileBytes: 50, maxBundleBytes: 80 },
  });

  beforeAll(async () => {
    await harness.setup();
  });

  concurrentTest(
    "enforces the overridden per-file limit on mint and the file count on finalize",
    async () => {
      const { taskRunId, claimToken } =
        await harness.claimTaskRun("bundle-limits");
      const taskRun = harness.apiClient.api["task-runs"]({ taskRunId });
      const headers = { ...harness.authHeaders };
      const bundle = await unwrapAsync(
        taskRun["artifact-bundles"].post(
          { claimToken, name: "small", rootPath: "out/small" },
          { headers },
        ),
      );

      const mint = await taskRun["artifact-upload-url"].post(
        {
          claimToken,
          relativeStorePath: "out/small/index.html",
          sizeBytes: 51,
          bundleId: bundle.id,
        },
        { headers },
      );
      expect(mint.error?.status).toBe(422);
      expect(mint.error?.value).toMatchObject({
        code: "ARTIFACT_BUNDLE_FILE_TOO_LARGE",
      });

      const { error } = await taskRun["artifact-bundles"]({
        bundleId: bundle.id,
      }).finalize.post(
        {
          claimToken,
          manifest: ["index.html", "a.js", "b.js"].map((path) => ({
            path,
            sizeBytes: 1,
          })),
        },
        { headers },
      );
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "ARTIFACT_BUNDLE_TOO_MANY_FILES",
      });
    },
  );
});
