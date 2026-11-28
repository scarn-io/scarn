import { beforeAll, describe, expect } from "bun:test";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { ArtifactShareServedDomainEventPayload } from "@/tasks/artifact-share/domain/artifact-share-served.domain-event";
import { serialTest, unwrapAsync } from "tests/utils";
import {
  BUNDLE_FILES,
  CONTENT_ORIGIN,
  createArtifactContentHarness,
  expectNotFoundPage,
} from "./artifact-content-test-harness";

describe("GET /s/:token/* on the content origin", () => {
  const content = createArtifactContentHarness("artifact-content-get");
  let token = "";
  let bundleId: UuidV7 | undefined;
  let shareId: UuidV7 | undefined;

  beforeAll(async () => {
    await content.harness.setup();
    const bundle = await content.createContentBundle("content-get");
    bundleId = bundle.bundleId;
    token = await content.shareBundle(bundle.bundleId);
    const status = await unwrapAsync(
      content
        .shareApi(bundle.bundleId)
        .get({ headers: { ...content.harness.authHeaders } }),
    );
    shareId = status.share?.id;
  });

  const url = (path: string) => `${CONTENT_ORIGIN}/s/${token}/${path}`;

  serialTest("serves the entry page at the bare share URL", async () => {
    const response = await content.request(url(""));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BUNDLE_FILES["index.html"]?.body ?? "");
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  serialTest("serves a nested member by path", async () => {
    const response = await content.request(url("assets/app.js"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      BUNDLE_FILES["assets/app.js"]?.body ?? "",
    );
  });

  serialTest("decodes a percent-encoded member path once", async () => {
    const response = await content.request(url("docs/a%20b.txt"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("spaced name");
  });

  serialTest("matches the header snapshot for a served file", async () => {
    const response = await content.request(url("index.html"));
    expect(Object.fromEntries(response.headers)).toEqual({
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
      "cache-control": "private, no-store",
      "content-length": String(BUNDLE_FILES["index.html"]?.body.length),
      "content-security-policy": `sandbox allow-scripts allow-popups allow-forms allow-downloads; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; frame-ancestors ${new URL(content.harness.appContext.appUrl ?? "").origin}`,
      "content-type": "text/html; charset=utf-8",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  });

  serialTest(
    "never adds credentialed CORS, even for a trusted origin",
    async () => {
      const response = await content.request(url(""), {
        headers: { origin: content.harness.appContext.appUrl ?? "" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.has("access-control-allow-credentials")).toBe(
        false,
      );
    },
  );

  serialTest("serves an unknown type as an attachment", async () => {
    const response = await content.request(url("data/blob.unknownext"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toStartWith(
      'attachment; filename="blob.unknownext"',
    );
  });

  serialTest("answers HEAD with the headers and no body", async () => {
    const response = await content.request(url("index.html"), {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(BUNDLE_FILES["index.html"]?.body.length),
    );
    expect(await response.text()).toBe("");
  });

  serialTest("redirects /s/:token to /s/:token/", async () => {
    const response = await content.request(`${CONTENT_ORIGIN}/s/${token}`);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/s/${token}/`);
  });

  serialTest(
    "emits ArtifactShareServed for each GET with bytes sent",
    async () => {
      content.served.length = 0;
      await (await content.request(url("assets/app.js"))).text();
      await (
        await content.request(url("index.html"), { method: "HEAD" })
      ).text();
      const expected: ArtifactShareServedDomainEventPayload[] = [
        {
          projectId: content.harness.projectId,
          bundleId: bundleId ?? createUuidV7(),
          shareId: shareId ?? null,
          path: "assets/app.js",
          bytes: BUNDLE_FILES["assets/app.js"]?.body.length ?? 0,
          via: "share",
        },
      ];
      expect(content.served.map((event) => event.payload)).toEqual(expected);
    },
  );

  describe("Range requests", () => {
    const clip = BUNDLE_FILES["media/clip.mp4"]?.body ?? "";

    serialTest("serves a byte range as 206", async () => {
      content.served.length = 0;
      const response = await content.request(url("media/clip.mp4"), {
        headers: { range: "bytes=2-5" },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(
        `bytes 2-5/${String(clip.length)}`,
      );
      expect(response.headers.get("content-length")).toBe("4");
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(await response.text()).toBe(clip.slice(2, 6));
      expect(content.served.at(-1)?.payload.bytes).toBe(4);
    });

    serialTest("serves a suffix range", async () => {
      const response = await content.request(url("media/clip.mp4"), {
        headers: { range: "bytes=-3" },
      });
      expect(response.status).toBe(206);
      expect(await response.text()).toBe(clip.slice(-3));
    });

    serialTest("answers an unsatisfiable range with 416", async () => {
      const response = await content.request(url("media/clip.mp4"), {
        headers: { range: "bytes=500-600" },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(
        `bytes */${String(clip.length)}`,
      );
    });

    serialTest(
      "ignores a malformed range and serves the whole file",
      async () => {
        const response = await content.request(url("media/clip.mp4"), {
          headers: { range: "lines=1-2" },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(clip);
      },
    );
  });

  describe("dot segments", () => {
    // URL parsing (here, in Bun.serve and in the Lambda adapter) resolves
    // `..` and `%2e%2e` before the app sees the path, so a dot segment can
    // only move within the URL; leaving `/s/<token>/` lands on a path that
    // is not a content route.
    serialTest("resolves `..` inside the bundle like a browser", async () => {
      const plain = await content.request(url("assets/../index.html"));
      const encoded = await content.request(url("assets/%2e%2e/index.html"));
      expect(plain.status).toBe(200);
      expect(encoded.status).toBe(200);
      expect(await encoded.text()).toBe(BUNDLE_FILES["index.html"]?.body ?? "");
    });

    serialTest("404s `..` that climbs out of the share prefix", async () => {
      await expectNotFoundPage(
        await content.request(url("../../api/projects")),
      );
      await expectNotFoundPage(
        await content.request(url("%2e%2e/%2e%2e/%2e%2e/etc/passwd")),
      );
    });
  });

  describe("paths that never serve", () => {
    const refused = [
      ["an unknown member", "missing.html"],
      ["a directory without index fallback", "assets/"],
      ["an encoded slash", "assets%2Fapp.js"],
      ["an encoded backslash", "assets%5Capp.js"],
      ["an encoded NUL", "index.html%00"],
      ["a broken escape", "index%zz.html"],
      ["an empty segment", "assets//app.js"],
      ["an encoded `..` with encoded slashes", "%2e%2e%2f%2e%2e%2fsecret"],
    ] as const;

    for (const [name, path] of refused) {
      serialTest(`404s ${name}`, async () => {
        await expectNotFoundPage(await content.request(url(path)));
      });
    }
  });
});
