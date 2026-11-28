import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { createArtifactBundleHarness } from "./artifact-bundle-test-harness";

describe("artifact bundle create endpoint", () => {
  const harness = createArtifactBundleHarness("artifact-bundle-post");
  const { apiClient, taskRunApi, createBundle } = harness;

  beforeAll(async () => {
    await harness.setup();
  });

  describe("create", () => {
    concurrentTest("returns 401 when unauthenticated", async () => {
      const { taskRunId, claimToken } =
        await harness.claimTaskRun("bundle-unauth");
      const { error } = await taskRunApi(taskRunId)["artifact-bundles"].post({
        claimToken,
        name: "report",
        rootPath: "out/report",
        entryPath: "index.html",
      });
      expect(error?.status).toBe(401);
    });

    concurrentTest("returns 403 for a non-member", async () => {
      const { taskRunId, claimToken } =
        await harness.claimTaskRun("bundle-non-member");
      const outsider = await createTestUserAndSession({
        email: `bundle-outsider-${crypto.randomUUID()}@example.com`,
      });
      const { error } = await taskRunApi(taskRunId)["artifact-bundles"].post(
        {
          claimToken,
          name: "report",
          rootPath: "out/report",
          entryPath: "index.html",
        },
        { headers: { ...outsider.authHeaders } },
      );
      expect(error?.status).toBe(403);
    });

    concurrentTest("returns 403 for a read-only member", async () => {
      const { taskRunId, claimToken } =
        await harness.claimTaskRun("bundle-read-only");
      const reader = await createTestUserAndSession({
        email: `bundle-reader-${crypto.randomUUID()}@example.com`,
      });
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: harness.projectId })
          .members({ userId: reader.userId })
          .role.put({ role: "read" }, { headers: { ...harness.authHeaders } }),
      );
      const { error } = await taskRunApi(taskRunId)["artifact-bundles"].post(
        {
          claimToken,
          name: "report",
          rootPath: "out/report",
          entryPath: "index.html",
        },
        { headers: { ...reader.authHeaders } },
      );
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({ code: "PROJECT_FORBIDDEN" });
    });

    concurrentTest("returns 409 when the claim token is wrong", async () => {
      const { taskRunId } = await harness.claimTaskRun("bundle-bad-claim");
      const { error } = await taskRunApi(taskRunId)["artifact-bundles"].post(
        {
          claimToken: "not-the-claim-token",
          name: "report",
          rootPath: "out/report",
          entryPath: "index.html",
        },
        { headers: { ...harness.authHeaders } },
      );
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ code: "TASK_OWNERSHIP_CONFLICT" });
    });

    concurrentTest("returns 409 for a duplicate name", async () => {
      const { taskRunId, claimToken } =
        await harness.claimTaskRun("bundle-duplicate");
      await createBundle(taskRunId, claimToken, { name: "dup" });
      const { error } = await taskRunApi(taskRunId)["artifact-bundles"].post(
        {
          claimToken,
          name: "dup",
          rootPath: "out/other",
          entryPath: "index.html",
        },
        { headers: { ...harness.authHeaders } },
      );
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ code: "ARTIFACT_BUNDLE_CONFLICT" });
    });

    concurrentTest(
      "returns 422 for an invalid name, root or entry",
      async () => {
        const { taskRunId, claimToken } =
          await harness.claimTaskRun("bundle-invalid");
        const cases = [
          {
            body: { name: "a/b", rootPath: "out", entryPath: "index.html" },
            code: "INVALID_ARTIFACT_BUNDLE_NAME",
          },
          {
            body: { name: "ok", rootPath: "out", entryPath: "app.js" },
            code: "INVALID_ARTIFACT_BUNDLE_ENTRY",
          },
          {
            body: { name: "ok", rootPath: "out", entryPath: "../x.html" },
            code: "INVALID_ARTIFACT_PATH",
          },
          {
            body: { name: "ok", rootPath: "/abs", entryPath: "index.html" },
            code: "INVALID_ARTIFACT_PATH",
          },
        ];
        for (const { body, code } of cases) {
          const { error } = await taskRunApi(taskRunId)[
            "artifact-bundles"
          ].post(
            { claimToken, ...body },
            { headers: { ...harness.authHeaders } },
          );
          expect(error?.status).toBe(422);
          expect(error?.value).toMatchObject({ code });
        }
      },
    );
  });

  describe("declared bundle fields", () => {
    const post = (
      taskRunId: UuidV7,
      body: {
        claimToken: string;
        name: string;
        rootPath: string;
        entryPath?: string;
        fieldPath?: string;
      },
    ) =>
      taskRunApi(taskRunId)["artifact-bundles"].post(body, {
        headers: { ...harness.authHeaders },
      });

    concurrentTest(
      "fills a declared field and defaults the entry to the field's",
      async () => {
        const { taskRunId, claimToken } =
          await harness.claimTaskRun("bundle-field-ok");
        const bundle = await unwrapAsync(
          post(taskRunId, {
            claimToken,
            name: "report",
            rootPath: "out/report",
            fieldPath: "report",
          }),
        );
        expect(bundle).toMatchObject({
          fieldPath: "report",
          entryPath: "report.html",
          status: "pending",
        });
      },
    );

    concurrentTest("defaults an undeclared bundle to index.html", async () => {
      const { taskRunId, claimToken } = await harness.claimTaskRun(
        "bundle-undeclared-default",
      );
      const bundle = await createBundle(taskRunId, claimToken);
      expect(bundle).toMatchObject({
        fieldPath: null,
        entryPath: "index.html",
      });
    });

    concurrentTest(
      "returns 422 for an unknown or non-bundle field",
      async () => {
        const { taskRunId, claimToken } = await harness.claimTaskRun(
          "bundle-field-unknown",
        );
        for (const fieldPath of ["missing", "summary", "screenshot"]) {
          const { error } = await post(taskRunId, {
            claimToken,
            name: `b-${fieldPath}`,
            rootPath: "out/report",
            fieldPath,
          });
          expect(error?.status).toBe(422);
          expect(error?.value).toMatchObject({
            code: "ARTIFACT_BUNDLE_FIELD_UNKNOWN",
          });
        }
      },
    );

    concurrentTest(
      "returns 422 when the entry differs from the declared entry",
      async () => {
        const { taskRunId, claimToken } = await harness.claimTaskRun(
          "bundle-field-entry-mismatch",
        );
        const { error } = await post(taskRunId, {
          claimToken,
          name: "report",
          rootPath: "out/report",
          entryPath: "index.html",
          fieldPath: "report",
        });
        expect(error?.status).toBe(422);
        expect(error?.value).toMatchObject({
          code: "ARTIFACT_BUNDLE_ENTRY_MISMATCH",
        });
      },
    );
  });
});
