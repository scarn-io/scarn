import { describe, expect, test } from "bun:test";
import { z as plainZod } from "zod";
import { z } from "../src";
import {
  Artifact,
  ArtifactTypes,
  artifact,
  normalizeArtifactAccept,
} from "../src/definitions/artifacts";
import { checkArtifactFields } from "../src/definitions/validation/validate-artifacts";

describe("normalizeArtifactAccept", () => {
  test.concurrent("treats an omitted list as accepting any file", () => {
    expect(normalizeArtifactAccept(undefined)).toEqual([]);
    expect(normalizeArtifactAccept([])).toEqual([]);
  });

  test.concurrent("keeps order and drops duplicates", () => {
    expect(normalizeArtifactAccept([".mp4", ".webm", ".mp4"])).toEqual([
      ".mp4",
      ".webm",
    ]);
  });

  test.concurrent("accepts multi-part extensions", () => {
    expect(normalizeArtifactAccept([".tar.gz"])).toEqual([".tar.gz"]);
  });

  test.concurrent("rejects an upper-case entry with a hint", () => {
    expect(() => normalizeArtifactAccept(["MP4"])).toThrow(
      "Did you mean `.mp4`?",
    );
    expect(() => normalizeArtifactAccept([".MP4"])).toThrow(
      '".MP4" must be lower-case. Did you mean `.mp4`?',
    );
  });

  test.concurrent("rejects an entry with no leading dot", () => {
    expect(() => normalizeArtifactAccept(["mp4"])).toThrow(
      '"mp4" must be a file extension starting with a dot. Did you mean `.mp4`?',
    );
  });

  test.concurrent("rejects an entry that is not an extension", () => {
    expect(() => normalizeArtifactAccept([".mp 4"])).toThrow(
      '".mp 4" is not a valid file extension.',
    );
    expect(() => normalizeArtifactAccept(["."])).toThrow(
      "is not a valid file extension",
    );
  });

  test.concurrent("reports every bad entry at once", () => {
    expect(() => normalizeArtifactAccept(["MP4", "gif", ".png"])).toThrow(
      /"MP4".*"gif"/,
    );
  });

  test.concurrent("presets expand to plain extensions", () => {
    expect(normalizeArtifactAccept([...ArtifactTypes.video, ".gif"])).toEqual([
      ".mp4",
      ".webm",
      ".mov",
      ".gif",
    ]);
    expect(normalizeArtifactAccept(ArtifactTypes.image)).toEqual([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".svg",
    ]);
  });
});

describe("artifact()", () => {
  test.concurrent("serialises to a string with the artifact keyword", () => {
    const schema = plainZod.object({
      video: artifact({ accept: [".mp4", ".mp4", ".webm"] }),
      any: artifact(),
    });
    expect(plainZod.toJSONSchema(schema)).toMatchObject({
      properties: {
        video: {
          type: "string",
          "x-scarn-artifact": { accept: [".mp4", ".webm"] },
        },
        any: { type: "string", "x-scarn-artifact": { accept: [] } },
      },
    });
  });

  test.concurrent("throws at definition time for a bad accept list", () => {
    expect(() => artifact({ accept: ["MP4"] })).toThrow("artifact({ accept })");
  });

  test.concurrent("keeps the keyword through nullable and describe", () => {
    const schema = plainZod.object({
      video: artifact({ accept: [".mp4"] })
        .nullable()
        .describe("Repro video"),
    });
    expect(plainZod.toJSONSchema(schema).properties?.["video"]).toMatchObject({
      description: "Repro video",
      anyOf: [
        { type: "string", "x-scarn-artifact": { accept: [".mp4"] } },
        { type: "null" },
      ],
    });
  });

  test.concurrent("parses plain strings", () => {
    expect(artifact().parse("out/video.mp4")).toBe(
      Artifact.path("out/video.mp4"),
    );
    expect(() => artifact().parse(42)).toThrow();
  });

  test.concurrent("z re-exports Zod with artifact attached", () => {
    expect(z.artifact).toBe(artifact);
    expect(typeof z.object).toBe("function");
    expect(z.toJSONSchema(z.object({ a: z.artifact() }))).toMatchObject({
      properties: { a: { "x-scarn-artifact": { accept: [] } } },
    });
  });
});

describe("artifact.bundle()", () => {
  test.concurrent(
    "serialises bundle and share; share: false is omitted",
    () => {
      const schema = z.object({
        report: z.artifact.bundle({ share: true }),
        site: artifact.bundle({ entry: "docs/start.html" }),
        plain: artifact.bundle(),
      });
      expect(z.toJSONSchema(schema).properties).toEqual({
        report: {
          type: "string",
          "x-scarn-artifact": {
            accept: [],
            bundle: { entry: "index.html" },
            share: true,
          },
        },
        site: {
          type: "string",
          "x-scarn-artifact": {
            accept: [],
            bundle: { entry: "docs/start.html" },
          },
        },
        plain: {
          type: "string",
          "x-scarn-artifact": { accept: [], bundle: { entry: "index.html" } },
        },
      });
    },
  );

  test.concurrent("rejects an entry that isn't a relative .html path", () => {
    expect(() => artifact.bundle({ entry: "report.md" })).toThrow(
      'artifact.bundle({ entry }): entry "report.md" must be an .html file.',
    );
    expect(() => artifact.bundle({ entry: "../index.html" })).toThrow(
      "must be a relative path inside the bundle",
    );
  });

  test.concurrent(
    "plain artifact() options don't allow bundle or share",
    () => {
      // @ts-expect-error share is only an artifact.bundle option
      artifact({ share: true });
      // @ts-expect-error bundle is only an artifact.bundle option
      artifact({ bundle: { entry: "index.html" } });
      // @ts-expect-error artifact.bundle has no accept option
      artifact.bundle({ accept: [".html"] });
    },
  );

  test.concurrent("parses a folder path", () => {
    expect(artifact.bundle().parse("report")).toBe(Artifact.path("report"));
  });
});

describe("artifact field validation", () => {
  const step = (resultSchemaJson: Record<string, unknown>) =>
    ({ key: "build", resultSchemaJson }) as Parameters<
      typeof checkArtifactFields
    >[0][number];

  test.concurrent("rejects a bundle field inside an array", () => {
    const issues = checkArtifactFields([
      step(z.toJSONSchema(z.object({ reports: z.array(artifact.bundle()) }))),
    ]);
    expect(issues.map((issue) => issue.message)).toEqual([
      'Step "build" declares bundle field "reports[]" inside an array. Bundle fields in arrays aren\'t supported; declare a fixed number of named bundle fields, or submit extra bundles without a field (undeclared bundles).',
    ]);
  });

  test.concurrent("rejects an unknown keyword key", () => {
    const issues = checkArtifactFields([
      step({
        type: "object",
        properties: {
          clip: { type: "string", "x-scarn-artifact": { accept: [], spa: 1 } },
        },
      }),
    ]);
    expect(issues.map((issue) => issue.message)).toEqual([
      'Step "build" artifact field "clip": unknown key "spa".',
    ]);
  });

  test.concurrent("rejects a stored entry that isn't .html", () => {
    const issues = checkArtifactFields([
      step({
        type: "object",
        properties: {
          report: {
            type: "string",
            "x-scarn-artifact": { accept: [], bundle: { entry: "a.md" } },
          },
        },
      }),
    ]);
    expect(issues.map((issue) => issue.message)).toEqual([
      'Step "build" bundle field "report": entry "a.md" must be an .html file.',
    ]);
  });

  test.concurrent("accepts bundle and file fields outside arrays", () => {
    expect(
      checkArtifactFields([
        step(
          z.toJSONSchema(
            z.object({
              report: artifact.bundle({ share: true }),
              clip: artifact(),
            }),
          ),
        ),
      ]),
    ).toEqual([]);
  });
});

describe("Artifact.path", () => {
  test.concurrent("returns the relative path unchanged", () => {
    const path: string = Artifact.path("shots/one.png");
    expect(path).toBe("shots/one.png");
  });
});
