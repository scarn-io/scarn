import type { ArtifactKind } from "@scarn/sdk/contracts/artifacts";

export type SaveArtifactInput = {
  taskRunId: string;
  sourcePath: string;
  relativeStorePath: string;
  /**
   * Classification of the artifact (e.g. Playwright trace vs. generic file),
   * computed at collection time from the store-relative path. Local stores
   * ignore it; the remote store forwards it to the record API.
   */
  kind: ArtifactKind;
  /**
   * Short-lived credential authorizing writes for this task. Local
   * stores ignore it; the remote store requires it to obtain a presigned
   * upload URL and to record the artifact against the API.
   */
  claimToken?: string | undefined;
  /** The pending bundle this file belongs to (remote only). */
  bundleId?: string | undefined;
};

export type SaveArtifactResult = {
  storeRef: string;
  sizeBytes: number;
};

/** One file of a bundle. `path` is relative to the bundle root. */
export type ArtifactBundleMember = {
  path: string;
  sourcePath: string;
  sizeBytes: number;
  kind: ArtifactKind;
};

/**
 * A folder saved as one bundle. `rootPath` is relative to the step-artifacts
 * folder (the same base as {@link SaveArtifactInput.relativeStorePath}), so a
 * member is stored at `<rootPath>/<member.path>`.
 */
export type SaveArtifactBundleInput = {
  taskRunId: string;
  claimToken?: string | undefined;
  name: string;
  rootPath: string;
  entryPath: string;
  /** The declared bundle field it fills; absent for an undeclared bundle. */
  fieldPath?: string | undefined;
  members: readonly ArtifactBundleMember[];
};

export type SaveArtifactBundleResult = {
  storeRef: string;
  sizeBytes: number;
  fileCount: number;
};

export interface ArtifactStore {
  saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult>;
  /**
   * Saves a whole bundle. Optional: a store without it gets each member
   * through `saveArtifact` (see {@link saveArtifactBundle}).
   */
  saveBundle?(
    input: SaveArtifactBundleInput,
  ): Promise<SaveArtifactBundleResult>;
  /**
   * Best-effort local disk cleanup, run periodically by callers that persist
   * artifacts on disk. Optional: stores with no local footprint to bound
   * (e.g. {@link RemoteArtifactStore}, whose retention is a separate,
   * already-existing server-side policy) simply don't implement it.
   */
  prune?(): Promise<void>;
}

export function bundleMemberStorePath(rootPath: string, memberPath: string) {
  return `${rootPath}/${memberPath}`;
}

/** Saves a bundle through `store.saveBundle`, or member by member. */
export async function saveArtifactBundle(
  store: ArtifactStore,
  input: SaveArtifactBundleInput,
): Promise<SaveArtifactBundleResult> {
  if (store.saveBundle) return store.saveBundle(input);
  let sizeBytes = 0;
  for (const member of input.members) {
    const result = await store.saveArtifact({
      taskRunId: input.taskRunId,
      claimToken: input.claimToken,
      sourcePath: member.sourcePath,
      relativeStorePath: bundleMemberStorePath(input.rootPath, member.path),
      kind: member.kind,
    });
    sizeBytes += result.sizeBytes;
  }
  return {
    storeRef: input.rootPath,
    sizeBytes,
    fileCount: input.members.length,
  };
}
