import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { defaultPlanId } from "@/billing/plan/application/default-plan-id";
import { currentBillingPeriod } from "@/billing/usage-meter/domain/billing-period";
import {
  buildPreviewToken,
  PREVIEW_TOKEN_TTL_MS,
} from "@/tasks/artifact-share/domain/preview-token";
import { createArtifactSharingConfig } from "@/tasks/artifact-share/domain/artifact-sharing-config";
import { createArtifactShareHarness } from "./artifact-share-test-harness";
import {
  BUNDLE_FILES,
  CONTENT_ORIGIN,
  CONTENT_SHARING_CONFIG,
  createArtifactContentHarness,
  expectNotFoundPage,
} from "./artifact-content-test-harness";

const NOW = new Date("2026-05-01T12:00:00.000Z");

describe("POST /projects/:projectId/artifact-bundles/:bundleId/preview", () => {
  const content = createArtifactContentHarness("artifact-content-preview");
  const { harness } = content;

  const previewApi = (bundleId: UuidV7) =>
    harness.apiClient.api
      .projects({ projectId: harness.projectId })
      ["artifact-bundles"]({ bundleId }).preview;

  const readsThisPeriod = async (): Promise<number> => {
    const org = await harness.appContext.orgRepo.findByProjectId(
      harness.projectId,
    );
    if (!org) throw new Error("Expected the project to have an org");
    const meter = await harness.appContext.usageMeterRepo.loadOrStart(
      org.id,
      currentBillingPeriod(NOW),
      defaultPlanId(),
    );
    return meter.reads;
  };

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest(
    "mints a 15-minute preview URL that serves the bundle",
    async () => {
      const { bundleId } = await content.createContentBundle("preview-mint");
      const readsBefore = await readsThisPeriod();

      const preview = await unwrapAsync(
        previewApi(bundleId).post({}, { headers: { ...harness.authHeaders } }),
      );
      expect(preview.url).toMatch(
        new RegExp(`^${CONTENT_ORIGIN}/p/pv1\\.[^/]+/$`),
      );
      expect(preview.expiresAt).toBe(
        new Date(NOW.getTime() + PREVIEW_TOKEN_TTL_MS).toISOString(),
      );
      expect(await readsThisPeriod()).toBe(readsBefore + 1);

      content.served.length = 0;
      const entry = await content.request(preview.url);
      expect(entry.status).toBe(200);
      expect(await entry.text()).toBe(BUNDLE_FILES["index.html"]?.body ?? "");
      const asset = await content.request(`${preview.url}assets/app.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe(
        BUNDLE_FILES["assets/app.js"]?.body ?? "",
      );
      expect(
        content.served.map(({ payload }) => ({
          bundleId: payload.bundleId,
          shareId: payload.shareId,
          path: payload.path,
          via: payload.via,
        })),
      ).toEqual([
        { bundleId, shareId: null, path: "index.html", via: "preview" },
        { bundleId, shareId: null, path: "assets/app.js", via: "preview" },
      ]);
      expect(await readsThisPeriod()).toBe(readsBefore + 1);
    },
  );

  serialTest("serves Range requests through a preview", async () => {
    const { bundleId } = await content.createContentBundle("preview-range");
    const preview = await unwrapAsync(
      previewApi(bundleId).post({}, { headers: { ...harness.authHeaders } }),
    );
    const response = await content.request(`${preview.url}media/clip.mp4`, {
      headers: { range: "bytes=0-1" },
    });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("01");
  });

  serialTest("refuses a non-member with 403", async () => {
    const { bundleId } =
      await content.createContentBundle("preview-non-member");
    const stranger = await createTestUserAndSession({
      email: `preview-stranger-${crypto.randomUUID()}@example.com`,
    });
    const { data, error } = await previewApi(bundleId).post(
      {},
      { headers: { ...stranger.authHeaders } },
    );
    expect(data).toBeNull();
    expect(error?.status).toBe(403);
  });

  serialTest("404s a deleted bundle and 409s an expired one", async () => {
    const deleted = await content.createContentBundle("preview-deleted");
    await content.markBundle(deleted.bundleId, { deletedAt: NOW });
    const gone = await previewApi(deleted.bundleId).post(
      {},
      { headers: { ...harness.authHeaders } },
    );
    expect(gone.error?.status).toBe(404);

    const expired = await content.createContentBundle("preview-expired");
    await content.markBundle(expired.bundleId, { expiredAt: NOW });
    const stale = await previewApi(expired.bundleId).post(
      {},
      { headers: { ...harness.authHeaders } },
    );
    expect(stale.error?.status).toBe(409);
  });

  describe("serving /p/:previewToken/*", () => {
    const secret = CONTENT_SHARING_CONFIG.shareSecret ?? "";
    const tokenFor = (bundleId: UuidV7, exp: Date, key = secret) =>
      buildPreviewToken(key, { bundleId, userId: "user-1", exp });
    const inFiveMinutes = new Date(NOW.getTime() + 5 * 60_000);

    serialTest("404s an expired, forged or malformed token", async () => {
      const { bundleId } = await content.createContentBundle("preview-bad");
      const expiredToken = tokenFor(bundleId, new Date(NOW.getTime() - 1000));
      const forged = tokenFor(bundleId, inFiveMinutes, "another-secret");
      for (const token of [expiredToken, forged, "pv1.garbage.mac"]) {
        await expectNotFoundPage(
          await content.request(`${CONTENT_ORIGIN}/p/${token}/`),
        );
      }
    });

    serialTest("410s a preview of a bundle that expired", async () => {
      const { bundleId } = await content.createContentBundle(
        "preview-bundle-expired",
      );
      const token = tokenFor(bundleId, inFiveMinutes);
      await content.markBundle(bundleId, { expiredAt: NOW });
      const response = await content.request(`${CONTENT_ORIGIN}/p/${token}/`);
      expect(response.status).toBe(410);
      expect(await response.text()).toContain("Link expired");
    });

    serialTest("404s a preview of a deleted bundle", async () => {
      const { bundleId } = await content.createContentBundle(
        "preview-bundle-deleted",
      );
      const token = tokenFor(bundleId, inFiveMinutes);
      await content.markBundle(bundleId, { deletedAt: NOW });
      await expectNotFoundPage(
        await content.request(`${CONTENT_ORIGIN}/p/${token}/`),
      );
    });

    serialTest("does not accept a preview token as a share token", async () => {
      const { bundleId } =
        await content.createContentBundle("preview-as-share");
      const token = tokenFor(bundleId, inFiveMinutes);
      await expectNotFoundPage(
        await content.request(`${CONTENT_ORIGIN}/s/${token}/`),
      );
    });
  });
});

describe("POST preview with sharing disabled", () => {
  const { harness } = createArtifactShareHarness(
    "artifact-content-preview-disabled",
    createArtifactSharingConfig({}),
  );

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest("answers 409 ARTIFACT_SHARING_DISABLED", async () => {
    const { bundleId } = await harness.createReadyBundle("preview-disabled");
    const { data, error } = await harness.apiClient.api
      .projects({ projectId: harness.projectId })
      ["artifact-bundles"]({ bundleId })
      .preview.post({}, { headers: { ...harness.authHeaders } });
    expect(data).toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.value).toMatchObject({ code: "ARTIFACT_SHARING_DISABLED" });
  });
});
