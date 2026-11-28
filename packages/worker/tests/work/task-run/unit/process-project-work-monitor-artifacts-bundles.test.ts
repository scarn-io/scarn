import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "bun:test";
import { writeStepArtifactSubmissions } from "@scarn/sdk/contracts/step-artifact-submissions";
import type {
  SaveArtifactBundleInput,
  SaveArtifactBundleResult,
} from "../../../../src/artifacts/artifact-store/domain/artifact-store";
import { collectStepArtifacts } from "../../../../src/work/task-run/application/collect-step-artifacts";
import { writeCurrentExecutionInfoFile } from "../../../../src/work/task-run/application/process-project-work-findings";
import {
  createDeps,
  createStartedTask,
} from "./helpers/process-project-work-monitor-artifacts-fixtures";

const fakeLogger = () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn() });

const bundleFieldSchema = (keyword: Record<string, unknown>) => ({
  type: "object",
  properties: {
    summary: { type: "string" },
    report: { type: "string", "x-scarn-artifact": keyword },
  },
});

async function seedWorkspace(files: Record<string, string>) {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "scarn-collect-bundles-"),
  );
  const stepArtifactsDir = path.join(workspacePath, ".scarn", "step-artifacts");
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(stepArtifactsDir, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  return workspacePath;
}

function bundleDeps() {
  const saveArtifact = vi.fn(() =>
    Promise.resolve({ storeRef: "ref", sizeBytes: 1 }),
  );
  const saveBundle = vi.fn<
    (input: SaveArtifactBundleInput) => Promise<SaveArtifactBundleResult>
  >(() =>
    Promise.resolve({ storeRef: "bundle-1", sizeBytes: 1, fileCount: 1 }),
  );
  const recordArtifactFailure = vi.fn(() => Promise.resolve(undefined));
  const deps = createDeps({
    callOrder: [],
    saveArtifact,
    saveBundle,
    completeTaskRun: vi.fn(),
    finalStepStatus: "succeeded",
    getSessionStatus: vi.fn(),
    recordArtifactFailure,
  });
  return { deps, saveArtifact, saveBundle, recordArtifactFailure };
}

const savedPaths = (saveArtifact: ReturnType<typeof vi.fn>) =>
  saveArtifact.mock.calls.map(
    (call) => (call[0] as { relativeStorePath: string }).relativeStorePath,
  );

describe("collectStepArtifacts bundles", () => {
  test.concurrent(
    "saves submitted bundles as bundles and other files one by one",
    async () => {
      const workspacePath = await seedWorkspace({
        "report/index.html": "<h1>report</h1>",
        "report/img/shot.png": "png",
        "prototype/index.html": "<h1>proto</h1>",
        "notes.txt": "hello",
      });
      await writeStepArtifactSubmissions(workspacePath, {
        fields: {
          report: {
            kind: "bundle",
            stored: "report",
            sourcePath: "out/report",
            sizeBytes: 18,
            entry: "index.html",
            fileCount: 2,
          },
        },
        extra: [
          {
            kind: "bundle",
            stored: "prototype",
            sourcePath: "dist",
            sizeBytes: 14,
            entry: "index.html",
            fileCount: 1,
          },
          { kind: "file", stored: "notes.txt", sourcePath: "n", sizeBytes: 5 },
        ],
      });
      const startedTask = createStartedTask(workspacePath);
      const { deps, saveArtifact, saveBundle } = bundleDeps();

      await collectStepArtifacts(deps, startedTask, fakeLogger());

      expect(savedPaths(saveArtifact)).toEqual(["notes.txt"]);
      expect(saveBundle).toHaveBeenCalledTimes(2);
      const bundles = saveBundle.mock.calls.map(([bundle]) => bundle);
      const report = bundles.find((bundle) => bundle.name === "report");
      expect(report).toMatchObject({
        taskRunId: startedTask.taskRunId,
        claimToken: startedTask.claimToken,
        rootPath: "report",
        entryPath: "index.html",
        fieldPath: "report",
      });
      expect(report?.members.map((member) => member.path).sort()).toEqual([
        "img/shot.png",
        "index.html",
      ]);
      const prototype = bundles.find((bundle) => bundle.name === "prototype");
      expect(prototype).toMatchObject({
        rootPath: "prototype",
        entryPath: "index.html",
      });
      expect(prototype).not.toHaveProperty("fieldPath");
    },
  );

  test.concurrent(
    "saves a code step's bundle field as a bundle with its fieldPath",
    async () => {
      const workspacePath = await seedWorkspace({
        "out/report/index.html": "<h1>report</h1>",
        "out/report/app.js": "1",
        "trace.zip": "zip",
      });
      await writeCurrentExecutionInfoFile(workspacePath, {
        taskRunId: "run-1",
        resultSchemaJson: bundleFieldSchema({
          accept: [],
          bundle: { entry: "index.html" },
        }),
        turnsRemaining: null,
      });
      const startedTask = createStartedTask(workspacePath);
      const { deps, saveArtifact, saveBundle } = bundleDeps();

      await collectStepArtifacts(deps, startedTask, fakeLogger(), {
        findingsJson: { summary: "ok", report: "out/report" },
      });

      expect(savedPaths(saveArtifact)).toEqual(["trace.zip"]);
      expect(saveBundle).toHaveBeenCalledTimes(1);
      expect(saveBundle.mock.calls[0]?.[0]).toMatchObject({
        name: "report",
        rootPath: "out/report",
        entryPath: "index.html",
        fieldPath: "report",
      });
    },
  );

  test.concurrent(
    "falls back to single files when the bundle field's keyword is unknown",
    async () => {
      const workspacePath = await seedWorkspace({
        "report/index.html": "<h1>report</h1>",
      });
      await writeCurrentExecutionInfoFile(workspacePath, {
        taskRunId: "run-1",
        resultSchemaJson: bundleFieldSchema({
          accept: [],
          bundle: { entry: "index.html" },
          future: true,
        }),
        turnsRemaining: null,
      });
      const startedTask = createStartedTask(workspacePath);
      const { deps, saveArtifact, saveBundle } = bundleDeps();

      await collectStepArtifacts(deps, startedTask, fakeLogger(), {
        findingsJson: { report: "report" },
      });

      expect(saveBundle).not.toHaveBeenCalled();
      expect(savedPaths(saveArtifact)).toEqual(["report/index.html"]);
    },
  );

  test.concurrent(
    "reports a failed bundle to recordArtifactFailure with the bundle name",
    async () => {
      const workspacePath = await seedWorkspace({
        "report/index.html": "<h1>report</h1>",
      });
      await writeStepArtifactSubmissions(workspacePath, {
        fields: {},
        extra: [
          {
            kind: "bundle",
            stored: "report",
            sourcePath: "out/report",
            sizeBytes: 15,
            entry: "index.html",
            fileCount: 1,
          },
        ],
      });
      const startedTask = createStartedTask(workspacePath);
      const { deps, saveBundle, recordArtifactFailure } = bundleDeps();
      saveBundle.mockImplementation(() =>
        Promise.reject(
          new Error(
            JSON.stringify({
              type: "about:blank",
              title: "Conflict",
              status: 409,
              code: "ARTIFACT_BUNDLE_CONFLICT",
              detail: "A bundle named report already exists.",
            }),
          ),
        ),
      );

      await collectStepArtifacts(deps, startedTask, fakeLogger());

      expect(recordArtifactFailure).toHaveBeenCalledWith({
        taskRunId: startedTask.taskRunId,
        claimToken: startedTask.claimToken,
        relativeStorePath: "report",
        attemptedSizeBytes: "<h1>report</h1>".length,
        errorCode: "ARTIFACT_BUNDLE_CONFLICT",
        errorMessage: "Bundle report: A bundle named report already exists.",
        httpStatus: 409,
      });
    },
  );
});
