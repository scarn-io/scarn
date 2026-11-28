import { describe, expect } from "bun:test";
import { CoreValidationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";
import {
  ARTIFACT_BUNDLE_LIMITS,
  artifactBundleExpiresAt,
  bundleMemberStorePath,
  isArtifactBundleExpired,
  bundleRelativePath,
  checkBundleManifest,
  normalizeArtifactBundleEntry,
  normalizeArtifactBundleName,
  parseArtifactBundleSpec,
  resolveArtifactBundleLimits,
} from "@/tasks/task-artifact/domain/artifact-bundle";

const expectValidationError = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreValidationError);
    expect((error as CoreValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} validation error`);
};

describe("normalizeArtifactBundleName", () => {
  concurrentTest("accepts and trims a single path segment", () => {
    expect(normalizeArtifactBundleName("  bug-report  ")).toBe("bug-report");
    expect(normalizeArtifactBundleName("proto.v2")).toBe("proto.v2");
  });

  concurrentTest("rejects empty, dot, multi-segment or backslash names", () => {
    for (const bad of ["", "   ", ".", "..", "a/b", "/a", "a/", "a\\b"]) {
      expectValidationError(
        () => normalizeArtifactBundleName(bad),
        "INVALID_ARTIFACT_BUNDLE_NAME",
      );
    }
  });
});

describe("normalizeArtifactBundleEntry", () => {
  concurrentTest("normalizes an .html path", () => {
    expect(normalizeArtifactBundleEntry("./pages//home.html")).toBe(
      "pages/home.html",
    );
    expect(normalizeArtifactBundleEntry("INDEX.HTML")).toBe("INDEX.HTML");
  });

  concurrentTest("rejects non-.html entries", () => {
    for (const bad of ["index.htm", "app.js", "index.html.txt", "html"]) {
      expectValidationError(
        () => normalizeArtifactBundleEntry(bad),
        "INVALID_ARTIFACT_BUNDLE_ENTRY",
      );
    }
  });

  concurrentTest("rejects entries escaping the root", () => {
    for (const bad of ["../index.html", "/index.html", "a/../../x.html"]) {
      expectValidationError(
        () => normalizeArtifactBundleEntry(bad),
        "INVALID_ARTIFACT_PATH",
      );
    }
  });
});

describe("parseArtifactBundleSpec", () => {
  concurrentTest("normalizes name, root and entry", () => {
    expect(
      parseArtifactBundleSpec({
        name: "report",
        rootPath: "./out//report/",
        entryPath: "views/main.html",
      }),
    ).toEqual({
      name: "report",
      rootPath: "out/report",
      entryPath: "views/main.html",
    });
  });

  concurrentTest("defaults the entry to index.html", () => {
    expect(
      parseArtifactBundleSpec({ name: "report", rootPath: "report" }).entryPath,
    ).toBe("index.html");
  });

  concurrentTest("rejects an unsafe root", () => {
    for (const bad of ["", "/abs", "../up", "a\\b"]) {
      expectValidationError(
        () => parseArtifactBundleSpec({ name: "r", rootPath: bad }),
        "INVALID_ARTIFACT_PATH",
      );
    }
  });
});

describe("bundle member paths", () => {
  concurrentTest("joins root and member into a run-relative path", () => {
    expect(bundleMemberStorePath("out/report", "./assets/app.js")).toBe(
      "out/report/assets/app.js",
    );
  });

  concurrentTest("rejects member paths escaping the root", () => {
    expectValidationError(
      () => bundleMemberStorePath("out/report", "../secret.txt"),
      "INVALID_ARTIFACT_PATH",
    );
  });

  concurrentTest("maps a run-relative path back to root-relative", () => {
    expect(bundleRelativePath("out/report", "out/report/index.html")).toBe(
      "index.html",
    );
    expect(bundleRelativePath("out/report", "out/report")).toBeNull();
    expect(bundleRelativePath("out/report", "out/reports/index.html")).toBe(
      null,
    );
    expect(bundleRelativePath("out/report", "other/index.html")).toBeNull();
  });
});

describe("resolveArtifactBundleLimits", () => {
  concurrentTest("defaults to the decision-16 limits", () => {
    expect(ARTIFACT_BUNDLE_LIMITS).toEqual({
      maxFiles: 1_000,
      maxFileBytes: 100 * 1024 * 1024,
      maxBundleBytes: 250 * 1024 * 1024,
    });
    expect(resolveArtifactBundleLimits()).toEqual(ARTIFACT_BUNDLE_LIMITS);
    expect(
      resolveArtifactBundleLimits({ ARTIFACT_BUNDLE_MAX_FILES: "  " }),
    ).toEqual(ARTIFACT_BUNDLE_LIMITS);
  });

  concurrentTest("applies env overrides", () => {
    expect(
      resolveArtifactBundleLimits({
        ARTIFACT_BUNDLE_MAX_FILES: "5000",
        ARTIFACT_BUNDLE_MAX_FILE_BYTES: "1024",
        ARTIFACT_BUNDLE_MAX_BYTES: "2048",
      }),
    ).toEqual({ maxFiles: 5000, maxFileBytes: 1024, maxBundleBytes: 2048 });
  });

  concurrentTest("rejects malformed overrides", () => {
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      expectValidationError(
        () => resolveArtifactBundleLimits({ ARTIFACT_BUNDLE_MAX_BYTES: bad }),
        "INVALID_ARTIFACT_BUNDLE_LIMIT",
      );
    }
  });
});

describe("checkBundleManifest", () => {
  const limits = { maxFiles: 3, maxFileBytes: 100, maxBundleBytes: 150 };
  const check = (
    manifest: { path: string; sizeBytes: number }[],
    members: { path: string; sizeBytes: number | null }[],
  ) =>
    checkBundleManifest({ entryPath: "index.html", manifest, members, limits });

  concurrentTest("returns the totals when members match the manifest", () => {
    expect(
      check(
        [
          { path: "./index.html", sizeBytes: 40 },
          { path: "a/b.js", sizeBytes: 60 },
        ],
        [
          { path: "index.html", sizeBytes: 40 },
          { path: "a/b.js", sizeBytes: 60 },
        ],
      ),
    ).toEqual({ fileCount: 2, sizeBytes: 100 });
  });

  concurrentTest("rejects missing, extra and mis-sized members", () => {
    expectValidationError(
      () =>
        check(
          [
            { path: "index.html", sizeBytes: 1 },
            { path: "a.js", sizeBytes: 1 },
          ],
          [{ path: "index.html", sizeBytes: 1 }],
        ),
      "ARTIFACT_BUNDLE_MEMBER_MISSING",
    );
    expectValidationError(
      () =>
        check(
          [{ path: "index.html", sizeBytes: 1 }],
          [
            { path: "index.html", sizeBytes: 1 },
            { path: "a.js", sizeBytes: 1 },
          ],
        ),
      "ARTIFACT_BUNDLE_MEMBER_UNEXPECTED",
    );
    expectValidationError(
      () =>
        check(
          [{ path: "index.html", sizeBytes: 2 }],
          [{ path: "index.html", sizeBytes: 1 }],
        ),
      "ARTIFACT_BUNDLE_MEMBER_SIZE_MISMATCH",
    );
  });

  concurrentTest(
    "rejects a manifest without the entry or with duplicates",
    () => {
      expectValidationError(
        () =>
          check(
            [{ path: "a.html", sizeBytes: 1 }],
            [{ path: "a.html", sizeBytes: 1 }],
          ),
        "ARTIFACT_BUNDLE_ENTRY_MISSING",
      );
      expectValidationError(
        () =>
          check(
            [
              { path: "index.html", sizeBytes: 1 },
              { path: "./index.html", sizeBytes: 1 },
            ],
            [{ path: "index.html", sizeBytes: 1 }],
          ),
        "ARTIFACT_BUNDLE_MANIFEST_DUPLICATE",
      );
    },
  );

  concurrentTest("enforces the file count and size limits", () => {
    expectValidationError(
      () =>
        check(
          ["index.html", "a", "b", "c"].map((path) => ({ path, sizeBytes: 1 })),
          [],
        ),
      "ARTIFACT_BUNDLE_TOO_MANY_FILES",
    );
    expectValidationError(
      () =>
        check(
          [{ path: "index.html", sizeBytes: 101 }],
          [{ path: "index.html", sizeBytes: 101 }],
        ),
      "ARTIFACT_BUNDLE_FILE_TOO_LARGE",
    );
    expectValidationError(
      () =>
        check(
          [
            { path: "index.html", sizeBytes: 100 },
            { path: "a", sizeBytes: 51 },
          ],
          [
            { path: "index.html", sizeBytes: 100 },
            { path: "a", sizeBytes: 51 },
          ],
        ),
      "ARTIFACT_BUNDLE_TOO_LARGE",
    );
  });
});

describe("artifact bundle expiry", () => {
  const createdAt = "2026-05-01T12:00:00.000Z";
  const DAY_MS = 24 * 60 * 60 * 1_000;

  concurrentTest("expires retentionDays after creation (30 by default)", () => {
    expect(artifactBundleExpiresAt({ createdAt }).toISOString()).toBe(
      "2026-05-31T12:00:00.000Z",
    );
    expect(artifactBundleExpiresAt({ createdAt }, 1).toISOString()).toBe(
      "2026-05-02T12:00:00.000Z",
    );
  });

  concurrentTest("is expired from the expiry moment, or once marked", () => {
    const expiresAt = artifactBundleExpiresAt({ createdAt }).getTime();
    const bundle = { createdAt, expiredAt: null };

    expect(isArtifactBundleExpired(bundle, new Date(expiresAt - 1))).toBe(
      false,
    );
    expect(isArtifactBundleExpired(bundle, new Date(expiresAt))).toBe(true);
    expect(
      isArtifactBundleExpired(
        { createdAt, expiredAt: "2026-05-02T00:00:00.000Z" },
        new Date(Date.parse(createdAt) + DAY_MS),
      ),
    ).toBe(true);
  });
});
