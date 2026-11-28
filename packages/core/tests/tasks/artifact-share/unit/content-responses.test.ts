import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { contentErrorPage } from "@/tasks/artifact-share/domain/content-error-pages";
import {
  buildContentSecurityPolicy,
  contentResponseHeaders,
  resolveContentType,
} from "@/tasks/artifact-share/domain/content-response-headers";
import {
  ARTIFACT_SHARE_SERVED_DOMAIN_EVENT_TYPE,
  ArtifactShareServedDomainEvent,
} from "@/tasks/artifact-share/domain/artifact-share-served.domain-event";
import { InMemoryContentRateLimiter } from "@/tasks/artifact-share/infra/in-memory-content-rate-limiter";
import {
  CONTENT_RATE_LIMIT_PER_IP_PER_MINUTE,
  CONTENT_RATE_LIMIT_PER_SHARE_PER_MINUTE,
  contentRateLimitKeys,
} from "@/tasks/artifact-share/application/content-rate-limiter";

const APP_ORIGIN = "https://app.scarn.dev";

describe("content security policy", () => {
  test("sandboxes the document and only lets the app frame it", () => {
    expect(buildContentSecurityPolicy(APP_ORIGIN)).toBe(
      "sandbox allow-scripts allow-popups allow-forms allow-downloads; " +
        "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; " +
        "form-action 'none'; " +
        "frame-ancestors https://app.scarn.dev",
    );
  });
});

describe("contentResponseHeaders", () => {
  test("sets every security header on a served file", () => {
    expect(
      contentResponseHeaders({
        appOrigin: APP_ORIGIN,
        contentType: "text/html",
        fileName: "index.html",
      }),
    ).toEqual({
      "Content-Security-Policy": buildContentSecurityPolicy(APP_ORIGIN),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "private, no-store",
      "Content-Type": "text/html; charset=utf-8",
    });
  });

  test("sandboxes SVG and XML like HTML", () => {
    for (const fileName of ["a.svg", "feed.xml"]) {
      const headers = contentResponseHeaders({
        appOrigin: APP_ORIGIN,
        contentType: null,
        fileName,
      });
      expect(headers["Content-Security-Policy"]).toStartWith("sandbox ");
      expect(headers["Content-Disposition"]).toBeUndefined();
    }
  });

  test("serves unknown types as a download", () => {
    const headers = contentResponseHeaders({
      appOrigin: APP_ORIGIN,
      contentType: null,
      fileName: 'dir/report "final".bin',
    });
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Content-Disposition"]).toBe(
      `attachment; filename="report _final_.bin"; filename*=UTF-8''report%20%22final%22.bin`,
    );
    expect(headers["Content-Security-Policy"]).toStartWith("sandbox ");
  });
});

describe("resolveContentType", () => {
  test("prefers the stored type, adding a charset to text", () => {
    expect(resolveContentType("image/png", "x.txt")).toBe("image/png");
    expect(resolveContentType("application/json", "x")).toBe(
      "application/json; charset=utf-8",
    );
    expect(resolveContentType("text/css; charset=latin1", "x")).toBe(
      "text/css; charset=latin1",
    );
  });

  test("falls back to the extension", () => {
    expect(resolveContentType(null, "app.MJS")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(resolveContentType("", "a/b/photo.jpeg")).toBe("image/jpeg");
    expect(resolveContentType("application/octet-stream", "m.wasm")).toBe(
      "application/wasm",
    );
    expect(resolveContentType(undefined, "font.woff2")).toBe("font/woff2");
  });

  test("is null when neither is known", () => {
    expect(resolveContentType(null, "README")).toBeNull();
    expect(resolveContentType(null, ".env")).toBeNull();
    expect(resolveContentType(null, "x.exe")).toBeNull();
  });
});

describe("contentErrorPage", () => {
  test("maps each kind to its status", () => {
    expect(contentErrorPage("not_found").status).toBe(404);
    expect(contentErrorPage("expired").status).toBe(410);
    expect(contentErrorPage("rate_limited").status).toBe(429);
  });

  test("is a small self-contained page", () => {
    for (const kind of ["not_found", "expired", "rate_limited"] as const) {
      const { html } = contentErrorPage(kind);
      expect(html).toStartWith("<!doctype html>");
      expect(html).not.toMatch(/https?:\/\/|src=|href=/);
      expect(html.length).toBeLessThan(2_000);
    }
  });
});

describe("InMemoryContentRateLimiter", () => {
  const now = new Date("2026-11-26T12:00:00.000Z");

  test("allows up to the limit per window, then reports when to retry", () => {
    const limiter = new InMemoryContentRateLimiter({ limitFor: () => 2 });
    expect(limiter.hit("k", now).allowed).toBe(true);
    expect(limiter.hit("k", now).allowed).toBe(true);
    expect(limiter.hit("k", new Date(now.getTime() + 15_000))).toEqual({
      allowed: false,
      retryAfterSeconds: 45,
    });
    expect(limiter.hit("other", now).allowed).toBe(true);
    expect(limiter.hit("k", new Date(now.getTime() + 60_000)).allowed).toBe(
      true,
    );
  });

  test("uses the per-share and per-IP defaults", () => {
    const limiter = new InMemoryContentRateLimiter();
    const keys = contentRateLimitKeys({
      shareId: "share-1",
      clientIp: "203.0.113.9",
    });
    const ipKey = keys.ip ?? "";
    expect(ipKey).toBe("ip:203.0.113.9");
    for (let i = 0; i < CONTENT_RATE_LIMIT_PER_IP_PER_MINUTE; i += 1) {
      expect(limiter.hit(ipKey, now).allowed).toBe(true);
    }
    expect(limiter.hit(ipKey, now).allowed).toBe(false);
    for (let i = 0; i < CONTENT_RATE_LIMIT_PER_SHARE_PER_MINUTE; i += 1) {
      expect(limiter.hit(keys.share, now).allowed).toBe(true);
    }
    expect(limiter.hit(keys.share, now).allowed).toBe(false);
    expect(
      contentRateLimitKeys({ shareId: "s", clientIp: null }).ip,
    ).toBeNull();
  });

  test("evicts the least recently used key past its capacity", () => {
    const limiter = new InMemoryContentRateLimiter({
      limitFor: () => 1,
      maxKeys: 2,
    });
    limiter.hit("a", now);
    limiter.hit("b", now);
    limiter.hit("a", now);
    limiter.hit("c", now);
    expect(limiter.hit("a", now).allowed).toBe(false);
    expect(limiter.hit("b", now).allowed).toBe(true);
  });
});

describe("ArtifactShareServedDomainEvent", () => {
  test("carries its payload", () => {
    const payload = {
      projectId: createUuidV7(),
      bundleId: createUuidV7(),
      shareId: createUuidV7(),
      path: "index.html",
      bytes: 42,
      via: "share" as const,
    };
    const event = new ArtifactShareServedDomainEvent(payload);
    expect(event.type).toBe(ARTIFACT_SHARE_SERVED_DOMAIN_EVENT_TYPE);
    expect(event.payload).toEqual(payload);
  });
});
