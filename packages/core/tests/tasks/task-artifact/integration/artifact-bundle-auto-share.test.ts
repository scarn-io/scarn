import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createArtifactSharingConfig } from "@/tasks/artifact-share/domain/artifact-sharing-config";
import { createArtifactShareHarness } from "tests/tasks/artifact-share/integration/artifact-share-test-harness";

/**
 * Auto-sharing on finalize (plan Phase 5, ADR 0020): only a bundle filling a
 * field the Task's result schema declares with `share: true` is shared, and
 * nothing in the request can change that.
 */
describe("artifact bundle auto-share", () => {
  const { harness, shareApi } = createArtifactShareHarness(
    "artifact-bundle-auto-share",
  );

  beforeAll(async () => {
    await harness.setup();
  });

  const finalizeBundle = async (
    workerId: string,
    bundle: { name: string; fieldPath?: string; entry: string },
  ): Promise<{ taskRunId: UuidV7; bundleId: UuidV7 }> => {
    const { taskRunId, claimToken } = await harness.claimTaskRun(workerId);
    const created = await harness.createBundle(taskRunId, claimToken, {
      name: bundle.name,
      rootPath: `out/${bundle.name}`,
      entryPath: bundle.entry,
      ...(bundle.fieldPath ? { fieldPath: bundle.fieldPath } : {}),
    });
    await harness.uploadMember({
      taskRunId,
      claimToken,
      bundleId: created.id,
      relativeStorePath: `out/${bundle.name}/${bundle.entry}`,
    });
    await unwrapAsync(
      harness.finalize(taskRunId, created.id, claimToken, [
        { path: bundle.entry },
      ]),
    );
    return { taskRunId, bundleId: created.id };
  };

  const shareStatus = (bundleId: UuidV7) =>
    unwrapAsync(
      shareApi(bundleId).get({ headers: { ...harness.authHeaders } }),
    );

  concurrentTest(
    "shares a bundle filling a declared share: true field on finalize",
    async () => {
      const { taskRunId, bundleId } = await finalizeBundle("auto-share", {
        name: "report",
        fieldPath: "report",
        entry: "report.html",
      });

      const status = await shareStatus(bundleId);
      expect(status).toMatchObject({
        status: "shared",
        reason: null,
        shareDeclared: true,
      });
      expect(status.share?.createdVia).toBe("step");
      expect(status.url).toStartWith("https://content.example.test/s/");

      const run = await harness.appContext.taskRunRepo.load(taskRunId);
      const stored = await harness.appContext.artifactShareRepo.findById(
        status.share?.id as UuidV7,
      );
      expect(stored).toMatchObject({
        createdVia: "step",
        createdByTaskId: run?.taskId,
        createdByUserId: null,
      });
    },
  );

  concurrentTest("a declared field without share stays private", async () => {
    const { bundleId } = await finalizeBundle("auto-share-notes", {
      name: "notes",
      fieldPath: "notes",
      entry: "index.html",
    });

    expect(await shareStatus(bundleId)).toMatchObject({
      status: "private",
      share: null,
      shareDeclared: false,
    });
  });

  concurrentTest(
    "an undeclared bundle named like a shared field stays private",
    async () => {
      const { bundleId } = await finalizeBundle("auto-share-undeclared", {
        name: "report",
        entry: "report.html",
      });

      expect(await shareStatus(bundleId)).toMatchObject({
        status: "private",
        share: null,
        shareDeclared: false,
      });
    },
  );

  concurrentTest(
    "a revoked declared bundle still reports shareDeclared",
    async () => {
      const { bundleId } = await finalizeBundle("auto-share-revoked", {
        name: "report",
        fieldPath: "report",
        entry: "report.html",
      });

      const revoked = await unwrapAsync(
        shareApi(bundleId).delete({}, { headers: { ...harness.authHeaders } }),
      );
      expect(revoked).toMatchObject({ status: "private", shareDeclared: true });
    },
  );

  concurrentTest("ignores sharing flags sent in the requests", async () => {
    const { taskRunId, claimToken } = await harness.claimTaskRun(
      "auto-share-request-flags",
    );
    const headers = { ...harness.authHeaders };
    const created = await unwrapAsync(
      harness.taskRunApi(taskRunId)["artifact-bundles"].post(
        {
          claimToken,
          name: "flagged",
          rootPath: "out/flagged",
          share: true,
          createdVia: "step",
        } as { claimToken: string; name: string; rootPath: string },
        { headers },
      ),
    );
    await harness.uploadMember({
      taskRunId,
      claimToken,
      bundleId: created.id,
      relativeStorePath: "out/flagged/index.html",
    });
    await unwrapAsync(
      harness
        .taskRunApi(taskRunId)
        ["artifact-bundles"]({ bundleId: created.id })
        .finalize.post(
          {
            claimToken,
            manifest: [{ path: "index.html", sizeBytes: 100 }],
            share: true,
            fieldPath: "report",
          } as {
            claimToken: string;
            manifest: { path: string; sizeBytes: number }[];
          },
          { headers },
        ),
    );

    expect(await shareStatus(created.id)).toMatchObject({
      status: "private",
      share: null,
    });
  });
});

describe("artifact bundle auto-share with sharing disabled", () => {
  const { harness, shareApi } = createArtifactShareHarness(
    "artifact-bundle-auto-share-disabled",
    createArtifactSharingConfig({ contentUrl: null, shareSecret: "secret" }),
  );

  beforeAll(async () => {
    await harness.setup();
  });

  concurrentTest(
    "finalizes a share: true bundle without sharing it",
    async () => {
      const { taskRunId, claimToken } =
        await harness.claimTaskRun("auto-share-off");
      const created = await harness.createBundle(taskRunId, claimToken, {
        name: "report",
        rootPath: "out/report",
        fieldPath: "report",
      });
      await harness.uploadMember({
        taskRunId,
        claimToken,
        bundleId: created.id,
        relativeStorePath: "out/report/report.html",
      });
      const finalized = await unwrapAsync(
        harness.finalize(taskRunId, created.id, claimToken, [
          { path: "report.html" },
        ]),
      );
      expect(finalized.status).toBe("ready");

      const status = await unwrapAsync(
        shareApi(created.id).get({ headers: { ...harness.authHeaders } }),
      );
      expect(status).toMatchObject({
        status: "unavailable",
        reason: "sharing_disabled",
        share: null,
        shareDeclared: true,
      });
    },
  );
});
