import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { artifactKindSchema } from "@scarn/sdk/contracts/artifacts";
import { z } from "zod";
import { ARTIFACT_BUNDLE_STATUSES } from "../domain/artifact-bundle";

export { artifactKindSchema };
export type { ArtifactKind } from "@scarn/sdk/contracts/artifacts";

const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * Request to mint a presigned PUT URL for uploading a task artifact.
 * The client supplies the worker `claimToken` (to prove ownership of the running
 * step) and the `relativeStorePath` the artifact should be addressed under; the
 * server derives the object key deterministically so clients cannot spoof it.
 *
 * `sizeBytes` is optional: the worker already knows the file's size before
 * requesting the upload URL (it reads the bytes into memory first) and passes
 * it so the pre-flight usage guard can check real storage headroom, not just
 * the write-count cap. Older workers/clients that omit it still work — the
 * guard falls back to a write-count-only check.
 */
export const createArtifactUploadUrlInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  relativeStorePath: nonEmptyStringSchema,
  contentType: z.string().trim().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  bundleId: uuidV7Schema.optional(),
});

/** Response carrying the minted upload URL and the resolved storage location. */
export const artifactUploadUrlSchema = z.object({
  uploadUrl: nonEmptyStringSchema,
  storeRef: nonEmptyStringSchema,
  objectKey: nonEmptyStringSchema,
  expiresInSeconds: z.number().int().positive(),
});

/**
 * Request to persist metadata for an artifact the client has already uploaded
 * to the presigned URL. `objectKey` must match the server-derived key or the
 * request is rejected (anti-spoof).
 */
export const recordArtifactInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  objectKey: nonEmptyStringSchema,
  relativeStorePath: nonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().trim().min(1).optional(),
  kind: artifactKindSchema.optional(),
  bundleId: uuidV7Schema.optional(),
});

/**
 * A persisted task artifact row. `storeRef`/`objectKey`/`sizeBytes`
 * are nullable: they are cleared once the artifact ages past
 * `STORAGE_RETENTION_DAYS` (see `clearExpiredArtifacts`), mirroring the S3
 * lifecycle rule that expires the underlying object under the same window.
 * `relativeStorePath` is NOT nulled — it is retained metadata about what the
 * step produced, even after the bytes themselves have expired.
 */
export const artifactSchema = z.object({
  id: uuidV7Schema,
  taskRunId: uuidV7Schema,
  projectId: uuidV7Schema,
  relativeStorePath: nonEmptyStringSchema,
  storeRef: nonEmptyStringSchema.nullable(),
  objectKey: nonEmptyStringSchema.nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  contentType: z.string().trim().min(1).nullable(),
  kind: artifactKindSchema,
  createdAt: z.iso.datetime(),
  /** The bundle this file is a member of; null for a single-file artifact. */
  bundleId: uuidV7Schema.nullable(),
});

/**
 * Request to open a `pending` artifact bundle. `rootPath` is a run-relative
 * store path; `entryPath` is the `.html` entry page, relative to the root,
 * and defaults to `index.html` (or the declared field's entry). `fieldPath`
 * names the declared bundle field in the Task's result schema this bundle
 * fills; omit it for an undeclared bundle. Name, root and entry are
 * validated by the bundle domain, not here.
 */
export const createArtifactBundleInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  rootPath: nonEmptyStringSchema,
  entryPath: nonEmptyStringSchema.optional(),
  fieldPath: nonEmptyStringSchema.optional(),
});

/** One member file the client uploaded, with its path relative to the root. */
export const artifactBundleManifestEntrySchema = z.object({
  path: nonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
});

/**
 * Request to finalize a bundle. The manifest lists every member the client
 * uploaded; finalize rejects it unless the recorded members match exactly.
 */
export const finalizeArtifactBundleInputSchema = z.object({
  claimToken: nonEmptyStringSchema,
  manifest: z.array(artifactBundleManifestEntrySchema).min(1),
});

export const artifactBundleStatusSchema = z.enum(ARTIFACT_BUNDLE_STATUSES);

/**
 * A persisted artifact bundle. `entryPath` is relative to `rootPath`.
 * `expiresAt` is when it ages past `STORAGE_RETENTION_DAYS` (with its
 * files); `expired` says whether that moment has passed.
 */
export const artifactBundleSchema = z.object({
  id: uuidV7Schema,
  taskRunId: uuidV7Schema,
  projectId: uuidV7Schema,
  name: nonEmptyStringSchema,
  fieldPath: nonEmptyStringSchema.nullable(),
  rootPath: nonEmptyStringSchema,
  entryPath: nonEmptyStringSchema,
  status: artifactBundleStatusSchema,
  fileCount: z.number().int().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  createdAt: z.iso.datetime(),
  finalizedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
});

export const listArtifactBundlesResponseSchema = z.array(artifactBundleSchema);

/**
 * A bundle as the dashboard's bundle page sees it: the bundle, whether it was
 * deleted (a deleted bundle is still returned so the page can say so), and
 * its non-deleted member files (empty once deleted).
 */
export const projectArtifactBundleDetailSchema = artifactBundleSchema.extend({
  deleted: z.boolean(),
  members: z.array(artifactSchema),
});

/**
 * Response carrying a presigned download URL for a single stored artifact.
 * `url` is nullable because object stores that cannot presign (e.g. the
 * in-memory test store) return null, signalling the caller to fall back to
 * proxying the bytes.
 */
export const artifactDownloadUrlSchema = z.object({
  url: nonEmptyStringSchema.nullable(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().trim().min(1).nullable(),
  relativeStorePath: nonEmptyStringSchema,
});

/** `artifactSchema` plus the originating node's key, for the project-wide list's inline "which step" context (decision 11). */
export const projectArtifactSchema = artifactSchema.extend({
  nodeKey: z.string().nullable(),
});

export const listProjectArtifactsResponseSchema = z.object({
  artifacts: z.array(projectArtifactSchema),
  /** The bundles that the listed members (`bundleId`) belong to. */
  bundles: z.array(artifactBundleSchema),
  hasMore: z.boolean(),
});

export const projectArtifactStatusSchema = z.enum([
  "available",
  "expired",
  "deleted",
]);

/**
 * Metadata for the durable artifact page: the file plus the run and step that
 * produced it. Storage coordinates are omitted; `status` says whether the
 * bytes can still be downloaded.
 */
export const projectArtifactDetailSchema = z.object({
  id: uuidV7Schema,
  taskRunId: uuidV7Schema,
  projectId: uuidV7Schema,
  relativeStorePath: nonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative().nullable(),
  contentType: z.string().trim().min(1).nullable(),
  kind: artifactKindSchema,
  createdAt: z.iso.datetime(),
  status: projectArtifactStatusSchema,
  pipelineRunId: uuidV7Schema.nullable(),
  attemptNumber: z.number().int().positive().nullable(),
  nodeKey: z.string().nullable(),
});

export const deleteProjectArtifactInputSchema = uuidV7Schema;
export const deleteProjectArtifactsInputSchema = z
  .array(deleteProjectArtifactInputSchema)
  .min(1);

export type CreateArtifactUploadUrlInput = z.input<
  typeof createArtifactUploadUrlInputSchema
>;
export type ArtifactUploadUrlContract = z.infer<typeof artifactUploadUrlSchema>;
export type RecordArtifactInput = z.input<typeof recordArtifactInputSchema>;
export type ArtifactContract = z.infer<typeof artifactSchema>;
export type CreateArtifactBundleInput = z.input<
  typeof createArtifactBundleInputSchema
>;
export type FinalizeArtifactBundleInput = z.input<
  typeof finalizeArtifactBundleInputSchema
>;
export type ArtifactBundleManifestEntry = z.infer<
  typeof artifactBundleManifestEntrySchema
>;
export type ArtifactBundleContract = z.infer<typeof artifactBundleSchema>;
export type ProjectArtifactBundleDetailContract = z.infer<
  typeof projectArtifactBundleDetailSchema
>;
export type ArtifactDownloadUrlContract = z.infer<
  typeof artifactDownloadUrlSchema
>;
export type ProjectArtifactContract = z.infer<typeof projectArtifactSchema>;
export type ProjectArtifactStatus = z.infer<typeof projectArtifactStatusSchema>;
export type ProjectArtifactDetailContract = z.infer<
  typeof projectArtifactDetailSchema
>;
export type ListProjectArtifactsResponse = z.infer<
  typeof listProjectArtifactsResponseSchema
>;
