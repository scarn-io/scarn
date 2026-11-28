import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { ARTIFACT_BUNDLE_LIMITS } from "@scarn/sdk/contracts/artifacts";
import {
  buildSubmitArtifactDescription,
  submitArtifact,
} from "./scarn-submit-artifact";

async function createWorkspace(
  resultSchemaJson: Record<string, unknown> | null,
): Promise<string> {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "scarn-submit-artifact-bundles-"),
  );
  await mkdir(path.join(workspacePath, ".scarn/current-execution"), {
    recursive: true,
  });
  await writeFile(
    path.join(workspacePath, ".scarn/current-execution/execution.json"),
    JSON.stringify({ taskRunId: "task-id", resultSchemaJson }),
  );
  return workspacePath;
}

async function writeSource(
  workspacePath: string,
  relativePath: string,
  content = "bytes",
): Promise<string> {
  const filePath = path.join(workspacePath, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

const readSubmissions = async (workspacePath: string): Promise<unknown> =>
  JSON.parse(
    await readFile(
      path.join(workspacePath, ".scarn/current-execution/artifacts.json"),
      "utf8",
    ),
  );

async function expectRejection(
  promise: Promise<object>,
  fragment: string,
): Promise<void> {
  expect(await promise.then(String, String)).toContain(fragment);
}

const BUNDLE_SCHEMA = {
  type: "object",
  required: ["report", "screenshot"],
  additionalProperties: false,
  properties: {
    report: {
      type: "string",
      "x-scarn-artifact": {
        accept: [],
        bundle: { entry: "app/index.html" },
        share: true,
      },
      description: "Interactive report",
    },
    screenshot: {
      type: "string",
      "x-scarn-artifact": { accept: [".png"] },
    },
  },
};

async function writeTree(
  workspacePath: string,
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    await writeSource(workspacePath, path.join(root, relativePath), content);
  }
}

function storedPath(workspacePath: string, stored: string): string {
  return path.join(workspacePath, ".scarn/step-artifacts", stored);
}

describe("submitArtifact with folders", () => {
  test("describes bundle fields and the authoring guide", () => {
    expect(buildSubmitArtifactDescription(BUNDLE_SCHEMA)).toMatchSnapshot();
  });

  test.concurrent(
    "copies a declared bundle field to <field>/ and records it",
    async () => {
      const workspacePath = await createWorkspace(BUNDLE_SCHEMA);
      await writeTree(workspacePath, "dist", {
        "app/index.html": "<html>",
        "app/assets/main.js": "js",
      });

      const result = await submitArtifact(
        { path: "dist", field: "report" },
        workspacePath,
      );

      expect(result).toEqual({
        ok: true,
        field: "report",
        stored: "report",
        bundle: { entry: "app/index.html", fileCount: 2, sizeBytes: 8 },
        warnings: [],
      });
      expect(
        await readFile(
          storedPath(workspacePath, "report/app/assets/main.js"),
          "utf8",
        ),
      ).toBe("js");
      expect(await readSubmissions(workspacePath)).toEqual({
        fields: {
          report: {
            kind: "bundle",
            stored: "report",
            sourcePath: "dist",
            sizeBytes: 8,
            entry: "app/index.html",
            fileCount: 2,
          },
        },
        extra: [],
      });
    },
  );

  test.concurrent(
    "stores an undeclared folder under its basename or name",
    async () => {
      const workspacePath = await createWorkspace(null);
      await writeTree(workspacePath, "out/site", { "index.html": "<html>" });
      await writeTree(workspacePath, "proto", { "main.html": "<html>" });

      const byBasename = await submitArtifact(
        { path: "out/site" },
        workspacePath,
      );
      const byName = await submitArtifact(
        { path: "proto", name: "prototype", entry: "main.html" },
        workspacePath,
      );

      expect(byBasename).toMatchObject({
        field: null,
        stored: "site",
        bundle: { entry: "index.html", fileCount: 1 },
      });
      expect(byName).toMatchObject({
        stored: "prototype",
        bundle: { entry: "main.html" },
      });
      expect(await readSubmissions(workspacePath)).toEqual({
        fields: {},
        extra: [
          {
            kind: "bundle",
            stored: "site",
            sourcePath: "out/site",
            sizeBytes: 6,
            entry: "index.html",
            fileCount: 1,
          },
          {
            kind: "bundle",
            stored: "prototype",
            sourcePath: "proto",
            sizeBytes: 6,
            entry: "main.html",
            fileCount: 1,
          },
        ],
      });
    },
  );

  test.concurrent("copies at submit time", async () => {
    const workspacePath = await createWorkspace(null);
    await writeTree(workspacePath, "site", { "index.html": "first" });

    await submitArtifact({ path: "site" }, workspacePath);
    await writeFile(path.join(workspacePath, "site/index.html"), "edited");

    expect(
      await readFile(storedPath(workspacePath, "site/index.html"), "utf8"),
    ).toBe("first");
  });

  test.concurrent(
    "rejects a folder for a file field and a file for a bundle field",
    async () => {
      const workspacePath = await createWorkspace(BUNDLE_SCHEMA);
      await writeTree(workspacePath, "shots", { "a.png": "png" });
      await writeSource(workspacePath, "index.html", "<html>");

      await expectRejection(
        submitArtifact({ path: "shots", field: "screenshot" }, workspacePath),
        "`screenshot` is a file field and accepts .png, but shots is a folder.",
      );
      await expectRejection(
        submitArtifact({ path: "index.html", field: "report" }, workspacePath),
        "`report` is a bundle field and needs a folder with entry page app/index.html, but index.html is a file.",
      );
    },
  );

  test.concurrent(
    "takes the entry from the field and requires it to exist",
    async () => {
      const workspacePath = await createWorkspace(BUNDLE_SCHEMA);
      await writeTree(workspacePath, "dist", { "index.html": "<html>" });

      await expectRejection(
        submitArtifact(
          { path: "dist", field: "report", entry: "index.html" },
          workspacePath,
        ),
        "`entry` comes from the field",
      );
      await expectRejection(
        submitArtifact({ path: "dist", field: "report" }, workspacePath),
        "has no entry page app/index.html.",
      );
      await expectRejection(
        submitArtifact({ path: "dist", entry: "missing.html" }, workspacePath),
        "has no entry page missing.html.",
      );
    },
  );

  test.concurrent(
    "rejects names and entries that leave the folder",
    async () => {
      const workspacePath = await createWorkspace(null);
      await writeTree(workspacePath, "site", { "index.html": "<html>" });

      for (const name of ["../site", "a/b", "..", "."]) {
        await expectRejection(
          submitArtifact({ path: "site", name }, workspacePath),
          "`name` for a folder must be a single folder name",
        );
      }
      for (const entry of ["../index.html", "/index.html", "app.js"]) {
        await expectRejection(
          submitArtifact({ path: "site", entry }, workspacePath),
          "`entry` is invalid",
        );
      }
      await writeSource(workspacePath, "page.html", "<html>");
      await expectRejection(
        submitArtifact({ path: "page.html", entry: "x.html" }, workspacePath),
        "`entry` is only for folders",
      );
    },
  );

  test.concurrent(
    "rejects a symlink out of the folder and accepts one inside it",
    async () => {
      const workspacePath = await createWorkspace(null);
      await writeSource(workspacePath, "secret.txt", "secret");
      await writeTree(workspacePath, "site", { "index.html": "<html>" });
      await symlink(
        path.join(workspacePath, "site/index.html"),
        path.join(workspacePath, "site/alias.html"),
      );

      const result = await submitArtifact({ path: "site" }, workspacePath);
      expect(result.bundle?.fileCount).toBe(2);
      expect(
        (await lstat(storedPath(workspacePath, "site/alias.html"))).isFile(),
      ).toBe(true);

      await symlink(
        path.join(workspacePath, "secret.txt"),
        path.join(workspacePath, "site/leak.txt"),
      );
      await expectRejection(
        submitArtifact({ path: "site", name: "site2" }, workspacePath),
        "leak.txt in",
      );
      expect(
        await Bun.file(storedPath(workspacePath, "site2/index.html")).exists(),
      ).toBe(false);
    },
  );

  test.concurrent("rejects an empty folder", async () => {
    const workspacePath = await createWorkspace(null);
    await mkdir(path.join(workspacePath, "empty/nested"), { recursive: true });

    await expectRejection(
      submitArtifact({ path: "empty" }, workspacePath),
      "Folder is empty",
    );
  });

  test.concurrent("rejects a folder over the file-count limit", async () => {
    const workspacePath = await createWorkspace(null);
    const files: Record<string, string> = { "index.html": "<html>" };
    for (let index = 0; index < ARTIFACT_BUNDLE_LIMITS.maxFiles; index += 1) {
      files[`f/${String(index)}.txt`] = "x";
    }
    await writeTree(workspacePath, "big", files);

    await expectRejection(
      submitArtifact({ path: "big" }, workspacePath),
      "holds more than 1000 files",
    );
  });

  test.concurrent("rejects a file over the per-file limit", async () => {
    const workspacePath = await createWorkspace(null);
    await writeTree(workspacePath, "big", { "index.html": "<html>" });
    await truncate(
      await writeSource(workspacePath, "big/video.bin", ""),
      ARTIFACT_BUNDLE_LIMITS.maxFileBytes + 1,
    );

    await expectRejection(
      submitArtifact({ path: "big" }, workspacePath),
      "a bundle file can be at most 100 MiB",
    );
  });

  test.concurrent("rejects a folder over the total size limit", async () => {
    const workspacePath = await createWorkspace(null);
    await writeTree(workspacePath, "big", { "index.html": "<html>" });
    for (const part of ["a", "b", "c"]) {
      await truncate(
        await writeSource(workspacePath, `big/${part}.bin`, ""),
        ARTIFACT_BUNDLE_LIMITS.maxFileBytes,
      );
    }

    await expectRejection(
      submitArtifact({ path: "big" }, workspacePath),
      "holds more than 250 MiB",
    );
  });

  test.concurrent(
    "replaces an earlier bundle and drops files no longer in it",
    async () => {
      const workspacePath = await createWorkspace(BUNDLE_SCHEMA);
      await writeTree(workspacePath, "v1", {
        "app/index.html": "one",
        "app/old.js": "old",
      });
      await writeTree(workspacePath, "v2", { "app/index.html": "two" });

      await submitArtifact({ path: "v1", field: "report" }, workspacePath);
      const result = await submitArtifact(
        { path: "v2", field: "report" },
        workspacePath,
      );

      expect(result.warnings).toEqual([
        "Replaced the earlier submission for `report` (report).",
      ]);
      expect(
        await Bun.file(storedPath(workspacePath, "report/app/old.js")).exists(),
      ).toBe(false);
      expect(await readSubmissions(workspacePath)).toMatchObject({
        fields: { report: { sourcePath: "v2", fileCount: 1 } },
      });
    },
  );

  test.concurrent(
    "replaces an undeclared file with an undeclared folder of the same name",
    async () => {
      const workspacePath = await createWorkspace(null);
      await writeSource(workspacePath, "report", "plain file");
      await writeTree(workspacePath, "site", { "index.html": "<html>" });

      await submitArtifact({ path: "report" }, workspacePath);
      const result = await submitArtifact(
        { path: "site", name: "report" },
        workspacePath,
      );

      expect(result.warnings).toEqual([
        "Replaced the earlier submission stored as report.",
      ]);
      expect(await readSubmissions(workspacePath)).toMatchObject({
        extra: [{ kind: "bundle", stored: "report" }],
      });
    },
  );

  test.concurrent(
    "refuses an undeclared name that overlaps another submission",
    async () => {
      const workspacePath = await createWorkspace(BUNDLE_SCHEMA);
      await writeTree(workspacePath, "dist", { "app/index.html": "<html>" });
      await writeTree(workspacePath, "site", { "index.html": "<html>" });
      await writeSource(workspacePath, "note.txt", "note");

      await submitArtifact({ path: "dist", field: "report" }, workspacePath);
      await expectRejection(
        submitArtifact({ path: "site", name: "report" }, workspacePath),
        "stored for `report`",
      );
      await expectRejection(
        submitArtifact(
          { path: "note.txt", name: "report/note.txt" },
          workspacePath,
        ),
        "stored for `report`",
      );

      await submitArtifact({ path: "site" }, workspacePath);
      await expectRejection(
        submitArtifact(
          { path: "note.txt", name: "site/note.txt" },
          workspacePath,
        ),
        "would overwrite the earlier submission stored as site",
      );
    },
  );
});
