import { describe, expect, test } from "bun:test";
import {
  applyContentOriginIsolationCheck,
  checkContentOriginIsolation,
  createArtifactSharingConfig,
  resolveArtifactSharingConfig,
} from "@/tasks/artifact-share/domain/artifact-sharing-config";
import { classifyContentRequest } from "@/tasks/artifact-share/domain/content-origin-gate";

const check = (
  contentUrl: string,
  overrides: {
    appUrl?: string | null;
    apiUrl?: string | null;
    cookieDomain?: string | null;
  } = {},
) =>
  checkContentOriginIsolation({
    contentUrl,
    appUrl: "https://app.scarn.dev",
    apiUrl: "https://api.scarn.dev",
    cookieDomain: null,
    ...overrides,
  });

describe("checkContentOriginIsolation", () => {
  test("accepts a host on its own registrable domain", () => {
    expect(check("https://scarn-content.net")).toEqual([]);
    expect(check("https://files.scarnusercontent.com")).toEqual([]);
  });

  test("rejects the app or API host, whatever the port", () => {
    const separateApi = { apiUrl: "https://api.other.dev" };
    expect(check("https://app.scarn.dev", separateApi)).toEqual([
      'content host "app.scarn.dev" is the app host',
    ]);
    expect(
      check("https://api.other.dev:8443", { appUrl: null, ...separateApi }),
    ).toEqual(['content host "api.other.dev" is the API host']);
  });

  test("rejects a host sharing the app's or API's registrable domain", () => {
    const problems = check("https://content.scarn.dev");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"scarn.dev"');
    expect(
      check("https://x.example.co.uk", { appUrl: "https://app.example.co.uk" }),
    ).not.toEqual([]);
  });

  test("rejects a host inside the auth cookie domain", () => {
    const options = { appUrl: null, apiUrl: null };
    expect(
      check("https://content.scarn.dev", {
        ...options,
        cookieDomain: ".scarn.dev",
      }),
    ).toEqual([
      'content host "content.scarn.dev" is inside the auth cookie domain "scarn.dev"',
    ]);
    expect(
      check("https://scarn.dev", { ...options, cookieDomain: "scarn.dev" }),
    ).toHaveLength(1);
    expect(
      check("https://notscarn.dev", { ...options, cookieDomain: "scarn.dev" }),
    ).toEqual([]);
  });

  test("treats distinct CloudFront distributions as distinct sites", () => {
    expect(
      check("https://d111.cloudfront.net", {
        appUrl: "https://d222.cloudfront.net",
        apiUrl: "https://d333.cloudfront.net",
      }),
    ).toEqual([]);
  });

  test("allows plain http only on local hosts", () => {
    expect(check("http://content.example.com")[0]).toContain("https");
    const local = {
      appUrl: "http://localhost:3000",
      apiUrl: "http://localhost:3001",
    };
    expect(check("http://artifacts.localhost:3001", local)).toEqual([]);
    expect(check("http://127.0.0.1:3001", local)).toEqual([]);
    expect(check("http://localhost:3002", local)[0]).toContain("app host");
  });

  test("rejects a URL that is not http(s)", () => {
    expect(check("not a url")).toHaveLength(1);
    expect(check("ftp://content.example.com")).toHaveLength(1);
  });
});

describe("applyContentOriginIsolationCheck", () => {
  const context = {
    appUrl: "https://app.scarn.dev",
    apiUrl: "https://api.scarn.dev/api",
    cookieDomain: null,
  };

  test("disables sharing and reports when the content origin is unsafe", () => {
    const reported: string[][] = [];
    const config = applyContentOriginIsolationCheck(
      createArtifactSharingConfig({
        contentUrl: "https://content.scarn.dev",
        shareSecret: "s",
      }),
      context,
      (problems) => reported.push(problems),
    );
    expect(config.enabled).toBe(false);
    expect(config.disabledReason).toBe("unsafe_content_origin");
    expect(reported).toHaveLength(1);
  });

  test("keeps a safe or unconfigured config as is", () => {
    const safe = createArtifactSharingConfig({
      contentUrl: "https://scarn-content.net",
      shareSecret: "s",
    });
    expect(applyContentOriginIsolationCheck(safe, context)).toBe(safe);
    const off = createArtifactSharingConfig({});
    expect(applyContentOriginIsolationCheck(off, context)).toBe(off);
    expect(off.disabledReason).toBe("not_configured");
  });

  test("reads the content-origin secret from the environment", () => {
    expect(
      resolveArtifactSharingConfig({
        SCARN_ARTIFACT_CONTENT_ORIGIN_SECRET: " origin-secret ",
      }).contentOriginSecret,
    ).toBe("origin-secret");
  });
});

describe("classifyContentRequest", () => {
  const hostConfig = createArtifactSharingConfig({
    contentUrl: "https://content.example.net",
    shareSecret: "s",
  });
  const secretConfig = createArtifactSharingConfig({
    contentUrl: "https://content.example.net",
    shareSecret: "s",
    contentOriginSecret: "origin-secret",
  });

  test("with an origin secret, only the secret header decides", () => {
    const classify = (originSecretHeader: string | null) =>
      classifyContentRequest({
        hostHeader: "content.example.net",
        originSecretHeader,
        config: secretConfig,
      });
    expect(classify("origin-secret")).toBe("content");
    expect(classify("wrong")).toBe("reject");
    expect(classify("")).toBe("reject");
    expect(classify(null)).toBe("api");
  });

  test("without an origin secret, the Host header decides", () => {
    const classify = (hostHeader: string | null) =>
      classifyContentRequest({
        hostHeader,
        originSecretHeader: null,
        config: hostConfig,
      });
    expect(classify("content.example.net")).toBe("content");
    expect(classify("CONTENT.example.net")).toBe("content");
    expect(classify("content.example.net:443")).toBe("content");
    expect(classify("content.example.net:8443")).toBe("api");
    expect(classify("api.example.com")).toBe("api");
    expect(classify("user@content.example.net")).toBe("api");
    expect(classify(null)).toBe("api");
  });

  test("compares the port for a content URL with an explicit one", () => {
    const config = createArtifactSharingConfig({
      contentUrl: "http://artifacts.localhost:3001",
      shareSecret: "s",
    });
    const classify = (hostHeader: string) =>
      classifyContentRequest({ hostHeader, originSecretHeader: null, config });
    expect(classify("artifacts.localhost:3001")).toBe("content");
    expect(classify("artifacts.localhost")).toBe("api");
    expect(classify("localhost:3001")).toBe("api");
  });

  test("with sharing disabled every request is for the API", () => {
    const disabled = { ...secretConfig, enabled: false };
    expect(
      classifyContentRequest({
        hostHeader: "content.example.net",
        originSecretHeader: "origin-secret",
        config: disabled,
      }),
    ).toBe("api");
  });
});
