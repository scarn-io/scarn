import { beforeAll, describe, expect } from "bun:test";
import { serialTest, unwrapAsync } from "tests/utils";
import { InMemoryContentRateLimiter } from "@/tasks/artifact-share/infra/in-memory-content-rate-limiter";
import { createArtifactSharingConfig } from "@/tasks/artifact-share/domain/artifact-sharing-config";
import { CONTENT_ORIGIN_SECRET_HEADER } from "@/tasks/artifact-share/domain/content-origin-gate";
import {
  API_ORIGIN,
  CONTENT_ORIGIN,
  createArtifactContentHarness,
  expectNotFoundPage,
} from "./artifact-content-test-harness";

const NOW = new Date("2026-05-01T12:00:00.000Z");

describe("the content origin's Host gate", () => {
  const content = createArtifactContentHarness("artifact-content-gate");
  let token = "";

  beforeAll(async () => {
    await content.harness.setup();
    const { bundleId } = await content.createContentBundle("gate");
    token = await content.shareBundle(bundleId);
  });

  serialTest("404s content paths on the API host", async () => {
    const response = await content.request(`${API_ORIGIN}/s/${token}/`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<title>Report</title>");
  });

  serialTest("404s API routes on the content host", async () => {
    await expectNotFoundPage(
      await content.request(
        `${CONTENT_ORIGIN}/api/projects/${content.harness.projectId}/artifacts`,
        { headers: { ...content.harness.authHeaders } },
      ),
    );
    await expectNotFoundPage(
      await content.request(`${CONTENT_ORIGIN}/api/openapi/json`),
    );
    await expectNotFoundPage(await content.request(`${CONTENT_ORIGIN}/`));
  });

  serialTest("404s non-GET methods on the content host", async () => {
    await expectNotFoundPage(
      await content.request(`${CONTENT_ORIGIN}/s/${token}/`, {
        method: "POST",
      }),
    );
  });

  serialTest("ignores X-Forwarded-Host", async () => {
    const response = await content.request(`${API_ORIGIN}/s/${token}/`, {
      headers: { "x-forwarded-host": new URL(CONTENT_ORIGIN).host },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<title>Report</title>");
  });

  serialTest("still serves the API on the API host", async () => {
    const response = await content.request(
      `${API_ORIGIN}/api/projects/${content.harness.projectId}/artifacts`,
      { headers: { ...content.harness.authHeaders } },
    );
    expect(response.status).toBe(200);
  });

  serialTest("404s a revoked link", async () => {
    const { bundleId } = await content.createContentBundle("gate-revoked");
    const revokedToken = await content.shareBundle(bundleId);
    await unwrapAsync(
      content
        .shareApi(bundleId)
        .delete({}, { headers: { ...content.harness.authHeaders } }),
    );
    await expectNotFoundPage(
      await content.request(`${CONTENT_ORIGIN}/s/${revokedToken}/`),
    );
  });

  serialTest("410s an expired bundle and 404s a deleted one", async () => {
    const expired = await content.createContentBundle("gate-expired");
    const expiredToken = await content.shareBundle(expired.bundleId);
    await content.markBundle(expired.bundleId, { expiredAt: NOW });
    const gone = await content.request(`${CONTENT_ORIGIN}/s/${expiredToken}/`);
    expect(gone.status).toBe(410);
    expect(gone.headers.get("content-security-policy")).toContain("sandbox");
    expect(await gone.text()).toContain("Link expired");

    const deleted = await content.createContentBundle("gate-deleted");
    const deletedToken = await content.shareBundle(deleted.bundleId);
    await content.markBundle(deleted.bundleId, { deletedAt: NOW });
    await expectNotFoundPage(
      await content.request(`${CONTENT_ORIGIN}/s/${deletedToken}/`),
    );
  });

  serialTest("404s a forged or tampered token", async () => {
    const tampered = `${token.slice(0, -2)}xx`;
    for (const bad of [tampered, "not-a-token", `${token}.extra`]) {
      await expectNotFoundPage(
        await content.request(`${CONTENT_ORIGIN}/s/${bad}/`),
      );
    }
  });

  serialTest("a token only reaches its own bundle's files", async () => {
    const other = await content.createContentBundle("gate-other");
    const otherToken = await content.shareBundle(other.bundleId);
    const own = await content.request(
      `${CONTENT_ORIGIN}/s/${otherToken}/index.html`,
    );
    expect(own.status).toBe(200);
    await expectNotFoundPage(
      await content.request(
        `${CONTENT_ORIGIN}/s/${otherToken}/..%2F..%2Fout%2Fsite%2Findex.html`,
      ),
    );
  });
});

describe("the content origin behind CloudFront", () => {
  const SECRET = "test-content-origin-secret";
  const content = createArtifactContentHarness(
    "artifact-content-secret",
    createArtifactSharingConfig({
      contentUrl: CONTENT_ORIGIN,
      shareSecret: "test-artifact-share-secret",
      contentOriginSecret: SECRET,
    }),
  );
  const FUNCTION_URL = "https://abc123.lambda-url.us-east-1.on.aws";
  let token = "";

  beforeAll(async () => {
    await content.harness.setup();
    const { bundleId } = await content.createContentBundle("secret");
    token = await content.shareBundle(bundleId);
  });

  serialTest("serves content when the secret header matches", async () => {
    const response = await content.request(`${FUNCTION_URL}/s/${token}/`, {
      headers: { [CONTENT_ORIGIN_SECRET_HEADER]: SECRET },
    });
    expect(response.status).toBe(200);
  });

  serialTest("does not trust the content Host without the secret", async () => {
    const response = await content.request(`${CONTENT_ORIGIN}/s/${token}/`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<title>Report</title>");
  });

  serialTest("404s every request carrying a wrong secret", async () => {
    for (const path of [`/s/${token}/`, "/api/openapi/json"]) {
      await expectNotFoundPage(
        await content.request(`${FUNCTION_URL}${path}`, {
          headers: { [CONTENT_ORIGIN_SECRET_HEADER]: "wrong" },
        }),
      );
    }
  });

  serialTest("never routes a request with the secret to the API", async () => {
    await expectNotFoundPage(
      await content.request(
        `${FUNCTION_URL}/api/projects/${content.harness.projectId}/artifacts`,
        {
          headers: {
            ...content.harness.authHeaders,
            [CONTENT_ORIGIN_SECRET_HEADER]: SECRET,
          },
        },
      ),
    );
  });
});

describe("content-origin rate limits", () => {
  const content = createArtifactContentHarness(
    "artifact-content-rate-limit",
    undefined,
    {
      contentRateLimiter: new InMemoryContentRateLimiter({
        limitFor: () => 2,
      }),
    },
  );

  beforeAll(async () => {
    await content.harness.setup();
  });

  serialTest("answers 429 with Retry-After past the share limit", async () => {
    const { bundleId } = await content.createContentBundle("rate-limit");
    const token = await content.shareBundle(bundleId);
    const url = `${CONTENT_ORIGIN}/s/${token}/`;
    expect((await content.request(url)).status).toBe(200);
    expect((await content.request(url)).status).toBe(200);
    const limited = await content.request(url);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("private, no-store");
    expect(await limited.text()).toContain("Too many requests");
  });
});
