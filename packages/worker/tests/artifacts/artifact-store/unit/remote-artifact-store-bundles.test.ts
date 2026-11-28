import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureRejection } from "../../../support/capture-rejection";
import { RemoteArtifactStore } from "../../../../src/artifacts/artifact-store/infra/remote-artifact-store";
import type { RemoteArtifactUploader } from "../../../../src/work/task-run/contracts/process-project-work-types";

type Call = { method: string; input: Record<string, unknown> };

const recordingUploader = (): {
  uploader: RemoteArtifactUploader;
  calls: Call[];
} => {
  const calls: Call[] = [];
  return {
    calls,
    uploader: {
      createArtifactBundle: (input) => {
        calls.push({ method: "createArtifactBundle", input });
        return Promise.resolve({ id: "bundle-1" });
      },
      createArtifactUploadUrl: (input) => {
        calls.push({ method: "createArtifactUploadUrl", input });
        return Promise.resolve({
          uploadUrl: `https://store.test/${input.relativeStorePath}`,
          storeRef: `s3://bucket/${input.relativeStorePath}`,
          objectKey: input.relativeStorePath,
          expiresInSeconds: 900,
        });
      },
      recordArtifact: (input) => {
        calls.push({ method: "recordArtifact", input });
        return Promise.resolve();
      },
      finalizeArtifactBundle: (input) => {
        calls.push({ method: "finalizeArtifactBundle", input });
        return Promise.resolve(undefined);
      },
    },
  };
};

describe("RemoteArtifactStore.saveBundle", () => {
  const previousFetch = globalThis.fetch;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "remote-artifact-bundle-"));
    await mkdir(path.join(dir, "report", "img"), { recursive: true });
    await writeFile(path.join(dir, "report", "index.html"), "<h1>hi</h1>");
    await writeFile(path.join(dir, "report", "img", "shot.png"), "png!");
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 200 }),
      )) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  const members = () => [
    {
      path: "index.html",
      sourcePath: path.join(dir, "report", "index.html"),
      sizeBytes: 11,
      kind: "generic" as const,
    },
    {
      path: "img/shot.png",
      sourcePath: path.join(dir, "report", "img", "shot.png"),
      sizeBytes: 4,
      kind: "image" as const,
    },
  ];

  test("creates the bundle, uploads each member with its bundleId, then finalizes", async () => {
    const { uploader, calls } = recordingUploader();
    const store = new RemoteArtifactStore(uploader);

    const result = await store.saveBundle({
      taskRunId: "run-1",
      claimToken: "claim-1",
      name: "report",
      rootPath: "report",
      entryPath: "index.html",
      fieldPath: "report",
      members: members(),
    });

    expect(calls.map((call) => call.method)).toEqual([
      "createArtifactBundle",
      "createArtifactUploadUrl",
      "recordArtifact",
      "createArtifactUploadUrl",
      "recordArtifact",
      "finalizeArtifactBundle",
    ]);
    expect(calls[0]?.input).toEqual({
      taskRunId: "run-1",
      claimToken: "claim-1",
      name: "report",
      rootPath: "report",
      entryPath: "index.html",
      fieldPath: "report",
    });
    expect(calls[1]?.input).toMatchObject({
      relativeStorePath: "report/index.html",
      bundleId: "bundle-1",
      sizeBytes: 11,
    });
    expect(calls[4]?.input).toMatchObject({
      relativeStorePath: "report/img/shot.png",
      bundleId: "bundle-1",
      kind: "image",
    });
    expect(calls[5]?.input).toEqual({
      taskRunId: "run-1",
      bundleId: "bundle-1",
      claimToken: "claim-1",
      manifest: [
        { path: "index.html", sizeBytes: 11 },
        { path: "img/shot.png", sizeBytes: 4 },
      ],
    });
    expect(result).toEqual({
      storeRef: "bundle-1",
      sizeBytes: 15,
      fileCount: 2,
    });
  });

  test("omits fieldPath for an undeclared bundle", async () => {
    const { uploader, calls } = recordingUploader();
    await new RemoteArtifactStore(uploader).saveBundle({
      taskRunId: "run-1",
      claimToken: "claim-1",
      name: "prototype",
      rootPath: "prototype",
      entryPath: "index.html",
      members: members(),
    });
    expect(calls[0]?.input).not.toHaveProperty("fieldPath");
  });

  test("does not finalize when a member upload fails", async () => {
    const { uploader, calls } = recordingUploader();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("nope", { status: 500, statusText: "Boom" }),
      )) as unknown as typeof fetch;

    const failure = await captureRejection(
      new RemoteArtifactStore(uploader).saveBundle({
        taskRunId: "run-1",
        claimToken: "claim-1",
        name: "report",
        rootPath: "report",
        entryPath: "index.html",
        members: members(),
      }),
    );
    expect(failure.message).toMatch(/500/);
    expect(calls.map((call) => call.method)).not.toContain(
      "finalizeArtifactBundle",
    );
  });

  test("requires a claimToken", async () => {
    const { uploader, calls } = recordingUploader();
    const failure = await captureRejection(
      new RemoteArtifactStore(uploader).saveBundle({
        taskRunId: "run-1",
        name: "report",
        rootPath: "report",
        entryPath: "index.html",
        members: members(),
      }),
    );
    expect(failure.message).toMatch(/requires a claimToken/);
    expect(calls).toHaveLength(0);
  });
});
