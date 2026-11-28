import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { artifact } from "../src/definitions/artifacts";
import {
  applyArtifactSubmissions,
  checkReturnedArtifactPaths,
  checkSubmittedArtifactFiles,
  findSubmittableArtifactFields,
  readStepArtifactSubmissions,
  writeStepArtifactSubmissions,
  type StepArtifactSubmissions,
} from "../src/contracts/step-artifact-submissions";

const bundleSchema = z.toJSONSchema(
  z.object({
    report: artifact.bundle({ share: true }),
    site: artifact.bundle({ entry: "docs/start.html" }).nullable(),
    clip: artifact().nullable(),
  }),
);
const bundleFields = findSubmittableArtifactFields(bundleSchema);

const submitted = (stored: string) => ({
  kind: "file" as const,
  stored,
  sourcePath: `/tmp/${stored}`,
  sizeBytes: 3,
});

const submittedBundle = (stored: string, entry = "index.html") => ({
  kind: "bundle" as const,
  stored,
  sourcePath: `/tmp/${stored}`,
  sizeBytes: 10,
  entry,
  fileCount: 2,
});

const writeStepArtifact = async (
  workspace: string,
  relativePath: string,
  contents = "x",
) => {
  const target = join(workspace, ".scarn/step-artifacts", relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents);
};

describe("bundle fields", () => {
  test.concurrent("fill writes the bundle root into the field", () => {
    const result = applyArtifactSubmissions({
      findings: {},
      fields: bundleFields,
      submissions: {
        fields: { report: submittedBundle("report") },
        extra: [submittedBundle("scratch")],
      },
      mode: "fill",
    });
    expect(result).toEqual({
      findings: { report: "report", site: null, clip: null },
      problems: [],
    });
  });

  test.concurrent("fill reports a missing required bundle", () => {
    const result = applyArtifactSubmissions({
      findings: {},
      fields: bundleFields,
      submissions: { fields: {}, extra: [] },
      mode: "fill",
    });
    expect(result.problems).toEqual([
      '`report` is required. Save the folder and call `scarn-submit-artifact` with `field: "report"` first.',
    ]);
  });

  test.concurrent("verify accepts a matching bundle root", () => {
    const findings = { report: "report", site: null, clip: null };
    expect(
      applyArtifactSubmissions({
        findings,
        fields: bundleFields,
        submissions: {
          fields: { report: submittedBundle("report") },
          extra: [],
        },
        mode: "verify",
      }),
    ).toEqual({ findings, problems: [] });
  });

  test.concurrent(
    "checkSubmittedArtifactFiles needs a folder holding the entry for a bundle field",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "scarn-bundles-"));
      await writeStepArtifact(workspace, "report/index.html");
      await writeStepArtifact(workspace, "report/app.js");
      await writeStepArtifact(workspace, "site/other.html");
      await writeStepArtifact(workspace, "clip/frame.png");

      expect(
        await checkSubmittedArtifactFiles({
          workspacePath: workspace,
          fields: bundleFields,
          submissions: {
            fields: {
              report: submittedBundle("report"),
              site: submittedBundle("site", "docs/start.html"),
              clip: { ...submittedBundle("clip"), kind: "bundle" },
            },
            extra: [],
          },
        }),
      ).toEqual([
        '`site` was submitted as site, but .scarn/step-artifacts/site has no entry page docs/start.html. Save the folder again and call `scarn-submit-artifact` with `field: "site"`.',
        '`clip` is a file field, but clip was submitted as a bundle. Save the file again and call `scarn-submit-artifact` with `field: "clip"`.',
      ]);

      expect(
        await checkSubmittedArtifactFiles({
          workspacePath: workspace,
          fields: bundleFields,
          submissions: {
            fields: {
              report: {
                ...submittedBundle("report/index.html"),
                kind: "bundle",
              },
              clip: { ...submitted("clip"), kind: "file" },
            },
            extra: [],
          },
        }),
      ).toEqual([
        '`report` was submitted as report/index.html, but .scarn/step-artifacts/report/index.html is a file, and a bundle field needs a folder. Save the folder again and call `scarn-submit-artifact` with `field: "report"`.',
        '`clip` was submitted as clip, but .scarn/step-artifacts/clip is a folder, and a file field needs a file. Save the file again and call `scarn-submit-artifact` with `field: "clip"`.',
      ]);
    },
  );

  test.concurrent(
    "checkReturnedArtifactPaths accepts a folder for a bundle field only",
    async () => {
      const workspace = await mkdtemp(
        join(tmpdir(), "scarn-returned-bundles-"),
      );
      await writeStepArtifact(workspace, "report/index.html");
      await writeStepArtifact(workspace, "site/docs/start.html");
      await writeStepArtifact(workspace, "clip/frame.png");
      await mkdir(join(workspace, ".scarn/step-artifacts/empty"), {
        recursive: true,
      });

      expect(
        await checkReturnedArtifactPaths({
          workspacePath: workspace,
          fields: bundleFields,
          findings: { report: "report", site: "site", clip: null },
        }),
      ).toEqual([]);

      expect(
        await checkReturnedArtifactPaths({
          workspacePath: workspace,
          fields: bundleFields,
          findings: {
            report: "report/index.html",
            site: "empty",
            clip: "clip",
          },
        }),
      ).toEqual([
        "`report` is report/index.html, but .scarn/step-artifacts/report/index.html is a file, and a bundle field needs a folder.",
        "`site` is empty, but .scarn/step-artifacts/empty is missing or empty.",
        "`clip` is clip, but .scarn/step-artifacts/clip is a folder, and a file field needs a file.",
      ]);

      expect(
        await checkReturnedArtifactPaths({
          workspacePath: workspace,
          fields: bundleFields,
          findings: { report: "site", site: null, clip: null },
        }),
      ).toEqual([
        "`report` is site, but .scarn/step-artifacts/site has no entry page index.html.",
      ]);
    },
  );
});

describe("artifacts.json compatibility", () => {
  test.concurrent("reads an older file without kind as files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scarn-old-artifacts-"));
    await mkdir(join(workspace, ".scarn/current-execution"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".scarn/current-execution/artifacts.json"),
      JSON.stringify({
        fields: {
          reproVideo: { stored: "a.webm", sourcePath: "a.webm", sizeBytes: 3 },
        },
        extra: [{ stored: "b.png", sourcePath: "b.png", sizeBytes: 4 }],
      }),
    );
    expect(await readStepArtifactSubmissions(workspace)).toEqual({
      fields: {
        reproVideo: {
          kind: "file",
          stored: "a.webm",
          sourcePath: "a.webm",
          sizeBytes: 3,
        },
      },
      extra: [
        { kind: "file", stored: "b.png", sourcePath: "b.png", sizeBytes: 4 },
      ],
    });
  });

  test.concurrent("round-trips bundles", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "scarn-bundle-artifacts-"));
    const submissions: StepArtifactSubmissions = {
      fields: { report: submittedBundle("report") },
      extra: [submittedBundle("scratch", "start.html")],
    };
    await writeStepArtifactSubmissions(workspace, submissions);
    expect(await readStepArtifactSubmissions(workspace)).toEqual(submissions);
  });
});
