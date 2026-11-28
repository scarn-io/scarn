import { stat } from "node:fs/promises";
import type { RemoteArtifactUploader } from "../../../work/task-run/contracts/process-project-work-types";
import { detectArtifactContentType } from "../domain/artifact-content-type";
import {
  bundleMemberStorePath,
  type ArtifactStore,
  type SaveArtifactBundleInput,
  type SaveArtifactBundleResult,
  type SaveArtifactInput,
  type SaveArtifactResult,
} from "../domain/artifact-store";

/**
 * Persists step artifacts to the app-owned object store via presigned PUT URLs
 * obtained from the API. The flow is:
 *
 *   1. `createArtifactUploadUrl` — ask the API for a presigned URL + object key.
 *   2. `PUT` the file to that URL, streamed from disk with its Content-Length.
 *   3. `recordArtifact` — tell the API the upload succeeded so it can persist
 *      the artifact row (size, content type, object key).
 *
 * A bundle wraps that flow: `createArtifactBundle` opens a pending bundle,
 * every member goes through the three steps with its `bundleId`, and
 * `finalizeArtifactBundle` marks it ready against the manifest.
 *
 * The API authorizes both control-plane calls with the task's
 * `claimToken`, which is threaded through {@link SaveArtifactInput.claimToken}
 * (local stores ignore it). Because the store is built once and reused across
 * executions, it cannot close over a single token — it reads the token off each
 * call and throws a clear error if it is missing.
 */
export class RemoteArtifactStore implements ArtifactStore {
  constructor(private readonly uploader: RemoteArtifactUploader) {}

  async saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> {
    const claimToken = requireClaimToken(
      input.claimToken,
      `artifact '${input.relativeStorePath}'`,
      input.taskRunId,
    );

    const { size: sizeBytes } = await stat(input.sourcePath);
    const contentType = detectArtifactContentType(input.relativeStorePath);
    const bundle = input.bundleId ? { bundleId: input.bundleId } : {};

    const { uploadUrl, storeRef, objectKey } =
      await this.uploader.createArtifactUploadUrl({
        taskRunId: input.taskRunId,
        claimToken,
        relativeStorePath: input.relativeStorePath,
        contentType,
        sizeBytes,
        ...bundle,
      });

    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: Bun.file(input.sourcePath),
      headers: {
        "content-type": contentType,
        "content-length": String(sizeBytes),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Artifact upload failed (${String(response.status)} ${response.statusText}) for '${input.relativeStorePath}': ${text}`,
      );
    }

    await this.uploader.recordArtifact({
      taskRunId: input.taskRunId,
      claimToken,
      objectKey,
      relativeStorePath: input.relativeStorePath,
      sizeBytes,
      contentType,
      kind: input.kind,
      ...bundle,
    });

    return { storeRef, sizeBytes };
  }

  async saveBundle(
    input: SaveArtifactBundleInput,
  ): Promise<SaveArtifactBundleResult> {
    const claimToken = requireClaimToken(
      input.claimToken,
      `bundle '${input.name}'`,
      input.taskRunId,
    );

    const bundle = await this.uploader.createArtifactBundle({
      taskRunId: input.taskRunId,
      claimToken,
      name: input.name,
      rootPath: input.rootPath,
      entryPath: input.entryPath,
      ...(input.fieldPath === undefined ? {} : { fieldPath: input.fieldPath }),
    });

    const manifest: { path: string; sizeBytes: number }[] = [];
    for (const member of input.members) {
      const result = await this.saveArtifact({
        taskRunId: input.taskRunId,
        claimToken,
        sourcePath: member.sourcePath,
        relativeStorePath: bundleMemberStorePath(input.rootPath, member.path),
        kind: member.kind,
        bundleId: bundle.id,
      });
      manifest.push({ path: member.path, sizeBytes: result.sizeBytes });
    }

    await this.uploader.finalizeArtifactBundle({
      taskRunId: input.taskRunId,
      bundleId: bundle.id,
      claimToken,
      manifest,
    });

    return {
      storeRef: bundle.id,
      sizeBytes: manifest.reduce((sum, member) => sum + member.sizeBytes, 0),
      fileCount: manifest.length,
    };
  }
}

function requireClaimToken(
  claimToken: string | undefined,
  what: string,
  taskRunId: string,
): string {
  if (!claimToken) {
    throw new Error(
      `RemoteArtifactStore requires a claimToken to upload ${what} for task ${taskRunId}.`,
    );
  }
  return claimToken;
}
