import type { ArtifactKind } from "@scarn/sdk/contracts/artifacts";

/**
 * The artifact routes of the worker client: presigned uploads, the artifact
 * record, bundles, and failure telemetry. Part of `TaskRunWorkerClient`.
 */
export type TaskRunArtifactClient = {
  createArtifactUploadUrl(input: {
    taskRunId: string;
    claimToken: string;
    relativeStorePath: string;
    contentType?: string | undefined;
    /**
     * The artifact's byte size, known here because the store reads the full
     * file into memory before requesting the upload URL (see
     * `RemoteArtifactStore.saveArtifact`). Passed through so the API's
     * pre-flight usage guard can check real storage headroom instead of only
     * the write-count cap.
     */
    sizeBytes?: number | undefined;
    /** The pending bundle this file belongs to; its path must be under the root. */
    bundleId?: string | undefined;
  }): Promise<{
    uploadUrl: string;
    storeRef: string;
    objectKey: string;
    expiresInSeconds: number;
  }>;
  /**
   * Opens a `pending` bundle. `rootPath` is run-relative (the same base as
   * `relativeStorePath`), `entryPath` root-relative. `fieldPath` names the
   * declared bundle field it fills.
   */
  createArtifactBundle(input: {
    taskRunId: string;
    claimToken: string;
    name: string;
    rootPath: string;
    entryPath?: string | undefined;
    fieldPath?: string | undefined;
  }): Promise<{ id: string }>;
  /** Marks the bundle `ready` once every manifest path (root-relative) is recorded. */
  finalizeArtifactBundle(input: {
    taskRunId: string;
    bundleId: string;
    claimToken: string;
    manifest: { path: string; sizeBytes: number }[];
  }): Promise<unknown>;
  /**
   * A presigned PUT URL for the Task's exported agent session, uploaded as
   * JSON before the Task yields. `sizeBytes` feeds the storage pre-flight.
   */
  recordArtifact(input: {
    taskRunId: string;
    claimToken: string;
    objectKey: string;
    relativeStorePath: string;
    sizeBytes: number;
    contentType?: string | undefined;
    kind: ArtifactKind;
    bundleId?: string | undefined;
  }): Promise<void>;
  /**
   * Best-effort telemetry for an artifact-save attempt that failed (storage
   * quota, network error, etc.). Purely informational — callers must treat a
   * failure to report as non-fatal (see `collectStepArtifacts`'s own
   * try/catch around this call) since it must never mask the real save
   * failure it is reporting.
   */
  recordArtifactFailure(input: {
    taskRunId: string;
    claimToken: string;
    relativeStorePath: string;
    attemptedSizeBytes: number;
    kind?: ArtifactKind | undefined;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number | undefined;
  }): Promise<void>;
};
