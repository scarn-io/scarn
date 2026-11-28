import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createArtifactBundleHarness } from "./artifact-bundle-test-harness";

const MIB = 1024 * 1024;

describe("artifact bundle member uploads", () => {
  const harness = createArtifactBundleHarness("artifact-bundle-members");
  const { taskRunApi, createBundle, finalize, recordMember } = harness;

  beforeAll(async () => {
    await harness.setup();
  });

  describe("member uploads", () => {
    concurrentTest(
      "rejects a path outside the bundle root on mint and record",
      async () => {
        const { taskRunId, claimToken } = await harness.claimTaskRun(
          "bundle-outside-root",
        );
        const bundle = await createBundle(taskRunId, claimToken);

        const mint = await taskRunApi(taskRunId)["artifact-upload-url"].post(
          {
            claimToken,
            relativeStorePath: "out/other/index.html",
            bundleId: bundle.id,
          },
          { headers: { ...harness.authHeaders } },
        );
        expect(mint.error?.status).toBe(422);
        expect(mint.error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_PATH_OUTSIDE_ROOT",
        });

        const record = await recordMember({
          taskRunId,
          claimToken,
          bundleId: bundle.id,
          relativeStorePath: "out/report-sibling/index.html",
          sizeBytes: 10,
        });
        expect(record.error?.status).toBe(422);
        expect(record.error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_PATH_OUTSIDE_ROOT",
        });
      },
    );

    concurrentTest(
      "returns 404 for a bundle from another task run",
      async () => {
        const other = await harness.claimTaskRun("bundle-other-run-a");
        const otherBundle = await createBundle(
          other.taskRunId,
          other.claimToken,
        );
        const { taskRunId, claimToken } =
          await harness.claimTaskRun("bundle-other-run-b");

        const mint = await taskRunApi(taskRunId)["artifact-upload-url"].post(
          {
            claimToken,
            relativeStorePath: "out/report/index.html",
            bundleId: otherBundle.id,
          },
          { headers: { ...harness.authHeaders } },
        );
        expect(mint.error?.status).toBe(404);
        expect(mint.error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_NOT_FOUND",
        });

        const record = await recordMember({
          taskRunId,
          claimToken,
          bundleId: otherBundle.id,
          relativeStorePath: "out/report/index.html",
          sizeBytes: 10,
        });
        expect(record.error?.status).toBe(404);

        const fin = await finalize(taskRunId, otherBundle.id, claimToken, [
          { path: "index.html" },
        ]);
        expect(fin.error?.status).toBe(404);
      },
    );

    concurrentTest(
      "returns 409 when uploading into a bundle that is not pending",
      async () => {
        const { taskRunId, claimToken } =
          await harness.claimTaskRun("bundle-not-pending");
        const bundle = await createBundle(taskRunId, claimToken);
        await harness.uploadMember({
          taskRunId,
          claimToken,
          bundleId: bundle.id,
          relativeStorePath: "out/report/index.html",
        });
        await unwrapAsync(
          finalize(taskRunId, bundle.id, claimToken, [{ path: "index.html" }]),
        );

        const mint = await taskRunApi(taskRunId)["artifact-upload-url"].post(
          {
            claimToken,
            relativeStorePath: "out/report/late.css",
            bundleId: bundle.id,
          },
          { headers: { ...harness.authHeaders } },
        );
        expect(mint.error?.status).toBe(409);
        expect(mint.error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_NOT_PENDING",
        });

        const record = await recordMember({
          taskRunId,
          claimToken,
          bundleId: bundle.id,
          relativeStorePath: "out/report/late.css",
          sizeBytes: 10,
        });
        expect(record.error?.status).toBe(409);

        const repeat = await unwrapAsync(
          finalize(taskRunId, bundle.id, claimToken, [{ path: "index.html" }]),
        );
        expect(repeat).toMatchObject({ id: bundle.id, status: "ready" });

        const changed = await finalize(taskRunId, bundle.id, claimToken, [
          { path: "index.html", sizeBytes: 5 },
        ]);
        expect(changed.error?.status).toBe(409);
        expect(changed.error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_NOT_PENDING",
        });
      },
    );

    concurrentTest(
      "returns 422 when a member exceeds the per-file limit",
      async () => {
        const { taskRunId, claimToken } = await harness.claimTaskRun(
          "bundle-file-too-large",
        );
        const bundle = await createBundle(taskRunId, claimToken);

        const mint = await taskRunApi(taskRunId)["artifact-upload-url"].post(
          {
            claimToken,
            relativeStorePath: "out/report/big.bin",
            sizeBytes: 101 * MIB,
            bundleId: bundle.id,
          },
          { headers: { ...harness.authHeaders } },
        );
        expect(mint.error?.status).toBe(422);
        expect(mint.error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_FILE_TOO_LARGE",
        });
      },
    );
  });
});
