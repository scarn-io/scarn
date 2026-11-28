import { beforeAll, describe, expect } from "bun:test";
import { serialTest, unwrapAsync } from "tests/utils";
import { resolveShareToken } from "@/tasks/artifact-share/application/resolve-share-token";
import { shareArtifactBundleAsSystem } from "@/tasks/artifact-share/application/share-artifact-bundle";
import { buildShareToken } from "@/tasks/artifact-share/domain/share-token";
import { createArtifactSharingConfig } from "@/tasks/artifact-share/domain/artifact-sharing-config";
import {
  TEST_SHARING_CONFIG,
  createArtifactShareHarness,
  tokenFromShareUrl,
} from "./artifact-share-test-harness";

describe("artifact share lifecycle", () => {
  const { harness, shareApi, markBundle, resolveDeps } =
    createArtifactShareHarness("artifact-share-lifecycle");

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest(
    "shares a ready bundle, resolves its token, then revokes it",
    async () => {
      const { taskRunId, bundleId } =
        await harness.createReadyBundle("share-lifecycle");
      const headers = { ...harness.authHeaders };

      const before = await unwrapAsync(shareApi(bundleId).get({ headers }));
      expect(before).toMatchObject({
        bundleId,
        status: "private",
        reason: null,
        url: null,
        share: null,
      });
      const bundle = await unwrapAsync(
        harness
          .taskRunApi(taskRunId)
          ["artifact-bundles"]({ bundleId })
          .get({ headers }),
      );
      expect(before.expiresAt).toBe(bundle.expiresAt);

      const shared = await unwrapAsync(
        shareApi(bundleId).post({}, { headers }),
      );
      expect(shared.status).toBe("shared");
      expect(shared.share?.createdVia).toBe("person");
      expect(shared.url).toStartWith("https://content.example.test/s/");
      const token = tokenFromShareUrl(shared.url);

      const again = await unwrapAsync(shareApi(bundleId).post({}, { headers }));
      expect(again.share?.id).toBe(shared.share?.id);
      expect(again.url).toBe(shared.url);

      const fetched = await unwrapAsync(shareApi(bundleId).get({ headers }));
      expect(fetched).toEqual(shared);

      const resolved = await resolveShareToken(token, resolveDeps());
      expect(resolved.ok && resolved.bundle.id).toBe(bundleId);

      const revoked = await unwrapAsync(
        shareApi(bundleId).delete({}, { headers }),
      );
      expect(revoked).toMatchObject({ status: "private", url: null });
      expect(await resolveShareToken(token, resolveDeps())).toEqual({
        ok: false,
        reason: "revoked",
      });

      const reshared = await unwrapAsync(
        shareApi(bundleId).post({}, { headers }),
      );
      expect(reshared.share?.id).not.toBe(shared.share?.id);
      expect(reshared.url).not.toBe(shared.url);
    },
  );

  serialTest("a token for one bundle never resolves another", async () => {
    const headers = { ...harness.authHeaders };
    const first = await harness.createReadyBundle("share-first", "first");
    const second = await harness.createReadyBundle("share-second", "second");
    const firstShare = await unwrapAsync(
      shareApi(first.bundleId).post({}, { headers }),
    );
    const secondShare = await unwrapAsync(
      shareApi(second.bundleId).post({}, { headers }),
    );

    const firstToken = tokenFromShareUrl(firstShare.url);
    const firstResolved = await resolveShareToken(firstToken, resolveDeps());
    expect(firstResolved.ok && firstResolved.bundle.id).toBe(first.bundleId);

    const [secondId] = tokenFromShareUrl(secondShare.url).split(".");
    const [, firstMac] = firstToken.split(".");
    const forged = `${String(secondId)}.${String(firstMac)}`;
    expect(await resolveShareToken(forged, resolveDeps())).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  serialTest(
    "an expired or deleted bundle's link stops resolving",
    async () => {
      const headers = { ...harness.authHeaders };
      const expiring = await harness.createReadyBundle(
        "share-expire",
        "expire",
      );
      const expiringShare = await unwrapAsync(
        shareApi(expiring.bundleId).post({}, { headers }),
      );
      await markBundle(expiring.bundleId, { expiredAt: new Date() });

      expect(
        await resolveShareToken(
          tokenFromShareUrl(expiringShare.url),
          resolveDeps(),
        ),
      ).toEqual({ ok: false, reason: "expired" });
      expect(
        await unwrapAsync(shareApi(expiring.bundleId).get({ headers })),
      ).toMatchObject({ status: "expired", url: null });

      const deleting = await harness.createReadyBundle(
        "share-delete",
        "delete",
      );
      const deletingShare = await unwrapAsync(
        shareApi(deleting.bundleId).post({}, { headers }),
      );
      await markBundle(deleting.bundleId, { deletedAt: new Date() });

      expect(
        await resolveShareToken(
          tokenFromShareUrl(deletingShare.url),
          resolveDeps(),
        ),
      ).toEqual({ ok: false, reason: "deleted" });
      expect(
        await unwrapAsync(shareApi(deleting.bundleId).get({ headers })),
      ).toMatchObject({ status: "deleted", url: null });
    },
  );

  serialTest(
    "a step can share a bundle without a person, and rotating the secret kills its link",
    async () => {
      const { bundleId } = await harness.createReadyBundle(
        "share-step",
        "step",
      );
      const shared = await shareArtifactBundleAsSystem(
        {
          projectId: harness.projectId,
          bundleId,
          createdVia: "step",
          createdByUserId: null,
          createdByTaskId: null,
        },
        resolveDeps(),
      );
      if (!shared.ok) throw shared.error;
      expect(shared.value).toMatchObject({
        status: "shared",
        share: { createdVia: "step" },
      });
      const token = tokenFromShareUrl(shared.value.url);

      const fetched = await unwrapAsync(
        shareApi(bundleId).get({ headers: { ...harness.authHeaders } }),
      );
      expect(fetched.url).toBe(shared.value.url);

      const rotated = createArtifactSharingConfig({
        contentUrl: TEST_SHARING_CONFIG.contentUrl,
        shareSecret: "rotated-secret",
      });
      expect(
        await resolveShareToken(token, {
          ...resolveDeps(),
          artifactSharingConfig: rotated,
        }),
      ).toEqual({ ok: false, reason: "invalid_token" });
      expect(
        await resolveShareToken(
          buildShareToken("rotated-secret", shared.value.share?.id ?? bundleId),
          { ...resolveDeps(), artifactSharingConfig: rotated },
        ),
      ).toMatchObject({ ok: true });
    },
  );
});

describe("artifact share lifecycle with sharing disabled", () => {
  const { harness, shareApi, resolveDeps } = createArtifactShareHarness(
    "artifact-share-disabled",
    createArtifactSharingConfig({ contentUrl: null, shareSecret: "secret" }),
  );

  beforeAll(async () => {
    await harness.setup();
  });

  serialTest(
    "reports sharing as unavailable and refuses to share",
    async () => {
      const { bundleId } = await harness.createReadyBundle("share-disabled");
      const headers = { ...harness.authHeaders };

      const status = await unwrapAsync(shareApi(bundleId).get({ headers }));
      expect(status).toMatchObject({
        status: "unavailable",
        reason: "sharing_disabled",
        url: null,
      });

      const { data, error } = await shareApi(bundleId).post({}, { headers });
      expect(data).toBeNull();
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ code: "ARTIFACT_SHARING_DISABLED" });

      expect(
        await resolveShareToken(
          buildShareToken("secret", bundleId),
          resolveDeps(),
        ),
      ).toEqual({ ok: false, reason: "sharing_disabled" });
    },
  );
});
