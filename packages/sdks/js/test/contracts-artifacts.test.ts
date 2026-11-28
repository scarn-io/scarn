import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  EMBEDDABLE_ARTIFACT_EXTENSIONS,
  artifactAcceptsFile,
  artifactBundleEntryProblem,
  artifactFileExtension,
  describeArtifactFieldProblem,
  findArtifactFields,
  findArtifactFieldsWithProblems,
  isEmbeddableArtifactExtension,
  matchArtifactNode,
} from "../src/contracts/artifacts";
import { artifact } from "../src/definitions/artifacts";

const KEYWORD = "x-scarn-artifact";

describe("findArtifactFields", () => {
  test.concurrent("returns nothing for a missing or plain schema", () => {
    expect(findArtifactFields(null)).toEqual([]);
    expect(findArtifactFields(undefined)).toEqual([]);
    expect(
      findArtifactFields(z.toJSONSchema(z.object({ a: z.string() }))),
    ).toEqual([]);
  });

  test.concurrent("finds top-level, nullable and nested fields", () => {
    const schema = z.toJSONSchema(
      z.object({
        reproVideo: artifact({ accept: [".mp4"] }).describe("The repro"),
        trace: artifact().nullable(),
        details: z.object({ screenshot: artifact({ accept: [".png"] }) }),
        summary: z.string(),
      }),
    );
    expect(findArtifactFields(schema)).toEqual([
      {
        path: "reproVideo",
        accept: [".mp4"],
        nullable: false,
        description: "The repro",
        inArray: false,
        bundle: null,
        share: false,
      },
      {
        path: "trace",
        accept: [],
        nullable: true,
        description: null,
        inArray: false,
        bundle: null,
        share: false,
      },
      {
        path: "details.screenshot",
        accept: [".png"],
        nullable: false,
        description: null,
        inArray: false,
        bundle: null,
        share: false,
      },
    ]);
  });

  test.concurrent("marks fields inside arrays", () => {
    const schema = z.toJSONSchema(
      z.object({
        shots: z.array(artifact({ accept: [".png"] })),
        runs: z.array(z.object({ video: artifact() })),
      }),
    );
    expect(
      findArtifactFields(schema).map(({ path, inArray }) => ({
        path,
        inArray,
      })),
    ).toEqual([
      { path: "shots[]", inArray: true },
      { path: "runs[].video", inArray: true },
    ]);
  });

  test.concurrent("follows local $refs and union branches", () => {
    const schema = {
      type: "object",
      properties: {
        clip: { $ref: "#/$defs/clip" },
        either: {
          oneOf: [
            {
              type: "object",
              properties: { a: { type: "string", [KEYWORD]: { accept: [] } } },
            },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
      },
      $defs: { clip: { type: "string", [KEYWORD]: { accept: [".webm"] } } },
    };
    expect(findArtifactFields(schema).map((field) => field.path)).toEqual([
      "clip",
      "either.a",
    ]);
  });

  test.concurrent("survives a self-referencing $ref", () => {
    const schema = {
      type: "object",
      properties: { loop: { $ref: "#" } },
    };
    expect(findArtifactFields(schema)).toEqual([]);
  });

  test.concurrent("does not treat the root as a field", () => {
    expect(findArtifactFields({ type: "string", [KEYWORD]: {} })).toEqual([]);
  });
});

describe("bundle fields", () => {
  test.concurrent("reads bundle and share", () => {
    const schema = z.toJSONSchema(
      z.object({
        report: artifact.bundle({ share: true }),
        site: artifact.bundle({ entry: "docs/start.html" }).nullable(),
      }),
    );
    expect(findArtifactFields(schema)).toEqual([
      {
        path: "report",
        accept: [],
        nullable: false,
        description: null,
        inArray: false,
        bundle: { entry: "index.html" },
        share: true,
      },
      {
        path: "site",
        accept: [],
        nullable: true,
        description: null,
        inArray: false,
        bundle: { entry: "docs/start.html" },
        share: false,
      },
    ]);
  });

  test.concurrent(
    "defaults a stored bundle with no entry to index.html",
    () => {
      const schema = {
        type: "object",
        properties: { report: { type: "string", [KEYWORD]: { bundle: {} } } },
      };
      expect(findArtifactFields(schema)[0]).toMatchObject({
        bundle: { entry: "index.html" },
        share: false,
      });
    },
  );

  test.concurrent("ignores share on a file field", () => {
    const schema = {
      type: "object",
      properties: {
        clip: { type: "string", [KEYWORD]: { accept: [], share: true } },
      },
    };
    expect(findArtifactFields(schema)[0]).toMatchObject({
      bundle: null,
      share: false,
    });
  });
});

describe("findArtifactFieldsWithProblems", () => {
  test.concurrent("a keyword without the new keys has no problems", () => {
    const schema = z.toJSONSchema(z.object({ clip: artifact() }));
    expect(findArtifactFieldsWithProblems(schema).problems).toEqual([]);
  });

  test.concurrent("reports unknown and malformed keys", () => {
    const schema = {
      type: "object",
      properties: {
        clip: { type: "string", [KEYWORD]: { accept: [], maxBytes: 5 } },
        report: {
          type: "string",
          [KEYWORD]: { accept: [], bundle: { entry: 3, spa: true }, share: 1 },
        },
      },
    };
    const { fields, problems } = findArtifactFieldsWithProblems(schema);
    expect(fields.map((field) => field.path)).toEqual(["clip", "report"]);
    expect(problems).toEqual([
      { path: "clip", message: 'unknown key "maxBytes"' },
      { path: "report", message: '"share" must be a boolean' },
      { path: "report", message: 'unknown key "bundle.spa"' },
      { path: "report", message: '"bundle.entry" must be a string' },
    ]);
    const [firstProblem] = problems;
    if (!firstProblem) throw new Error("Expected an artifact field problem");
    expect(describeArtifactFieldProblem(firstProblem)).toBe(
      'Artifact field `clip`: unknown key "maxBytes"; this step needs a newer Scarn worker.',
    );
  });

  test.concurrent("findArtifactFields still returns the fields", () => {
    const schema = {
      type: "object",
      properties: {
        clip: { type: "string", [KEYWORD]: { accept: [], future: {} } },
      },
    };
    expect(findArtifactFields(schema).map((field) => field.path)).toEqual([
      "clip",
    ]);
  });
});

describe("artifactBundleEntryProblem", () => {
  test.concurrent("accepts relative .html paths", () => {
    expect(artifactBundleEntryProblem("index.html")).toBeNull();
    expect(artifactBundleEntryProblem("docs/Start.HTML")).toBeNull();
  });

  test.concurrent("rejects other paths", () => {
    for (const entry of [
      "",
      "/index.html",
      "../index.html",
      "a/./index.html",
      "a//index.html",
      "a\\index.html",
    ]) {
      expect(artifactBundleEntryProblem(entry)).toContain(
        "must be a relative path",
      );
    }
    expect(artifactBundleEntryProblem("report.md")).toContain(
      "must be an .html file",
    );
  });
});

describe("matchArtifactNode", () => {
  test.concurrent("matches direct and nullable nodes only", () => {
    const direct = { type: "string", [KEYWORD]: { accept: [".png"] } };
    expect(matchArtifactNode(direct)).toEqual({
      accept: [".png"],
      nullable: false,
      description: null,
      bundle: null,
      share: false,
      problems: [],
    });
    expect(
      matchArtifactNode({ anyOf: [direct, { type: "null" }] }),
    ).toMatchObject({ nullable: true });
    expect(
      matchArtifactNode({ anyOf: [direct, { type: "number" }] }),
    ).toBeNull();
    expect(matchArtifactNode({ type: "string" })).toBeNull();
    expect(matchArtifactNode(true)).toBeNull();
  });
});

describe("artifact extension helpers", () => {
  test.concurrent("extracts lower-cased extensions", () => {
    expect(artifactFileExtension("out/Video.MP4")).toBe(".mp4");
    expect(artifactFileExtension("README")).toBe("");
    expect(artifactFileExtension(".hidden")).toBe("");
    expect(artifactFileExtension("dir.d/file")).toBe("");
  });

  test.concurrent("checks files against accept", () => {
    expect(artifactAcceptsFile([], "anything.bin")).toBe(true);
    expect(artifactAcceptsFile([".mp4"], "clip.MP4")).toBe(true);
    expect(artifactAcceptsFile([".mp4"], "clip.webm")).toBe(false);
  });

  test.concurrent("only Jira embeds in v1", () => {
    expect(EMBEDDABLE_ARTIFACT_EXTENSIONS.jira).toEqual([
      ".png",
      ".gif",
      ".mp4",
      ".webm",
    ]);
    expect(isEmbeddableArtifactExtension("jira", ".MP4")).toBe(true);
    expect(isEmbeddableArtifactExtension("jira", ".mov")).toBe(false);
    expect(isEmbeddableArtifactExtension("github", ".png")).toBe(false);
    expect(isEmbeddableArtifactExtension("bitbucket", ".png")).toBe(false);
  });
});
