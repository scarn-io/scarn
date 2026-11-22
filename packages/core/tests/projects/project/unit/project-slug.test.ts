import { describe, expect } from "bun:test";
import {
  deduplicateProjectSlug,
  isProjectSlug,
  slugify,
} from "@/projects/project/domain/project-slug";
import { concurrentTest } from "tests/utils";

// slugify / deduplicateProjectSlug return the branded `ProjectSlug` type;
// compare as plain strings so bun's `toBe` type argument matches.
const asString = (value: string): string => value;

describe("slugify", () => {
  concurrentTest("lowercases and hyphenates spaces and symbols", () => {
    expect(asString(slugify("Delivery Platform"))).toBe("delivery-platform");
    expect(asString(slugify("HRA Hub"))).toBe("hra-hub");
    expect(asString(slugify("My  Cool   Project!!!"))).toBe("my-cool-project");
  });

  concurrentTest("trims leading/trailing separators", () => {
    expect(asString(slugify("  --Hello World--  "))).toBe("hello-world");
    expect(asString(slugify("...edge..."))).toBe("edge");
  });

  concurrentTest("collapses accents via NFKD normalization", () => {
    expect(asString(slugify("Café Déjà Vu"))).toBe("cafe-deja-vu");
  });

  concurrentTest("falls back to 'project' when nothing slug-able remains", () => {
    expect(asString(slugify("!!!"))).toBe("project");
    expect(asString(slugify("   "))).toBe("project");
    expect(asString(slugify("——"))).toBe("project");
  });

  concurrentTest("always produces a valid slug", () => {
    for (const name of ["A", "9", "已经", "Test 123", "  weird__name  "]) {
      expect(isProjectSlug(slugify(name))).toBe(true);
    }
  });

  concurrentTest("truncates to the max length", () => {
    const long = "a".repeat(200);
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(isProjectSlug(result)).toBe(true);
  });
});

describe("deduplicateProjectSlug", () => {
  concurrentTest("returns the base slug when free", () => {
    expect(asString(deduplicateProjectSlug("my-project", new Set()))).toBe(
      "my-project",
    );
    expect(
      asString(deduplicateProjectSlug("my-project", new Set(["other-project"]))),
    ).toBe("my-project");
  });

  concurrentTest("appends -2, -3, … on collision", () => {
    expect(
      asString(deduplicateProjectSlug("my-project", new Set(["my-project"]))),
    ).toBe("my-project-2");
    expect(
      asString(
        deduplicateProjectSlug(
          "my-project",
          new Set(["my-project", "my-project-2"]),
        ),
      ),
    ).toBe("my-project-3");
  });

  concurrentTest("keeps the suffix within the length limit", () => {
    const base = "a".repeat(64);
    const result = deduplicateProjectSlug(base, new Set([base]));
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.endsWith("-2")).toBe(true);
    expect(isProjectSlug(result)).toBe(true);
  });
});
