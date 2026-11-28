import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import {
  ARTIFACT_SHARE_CREATED_VIA,
  ARTIFACT_SHARE_STATUSES,
} from "../domain/artifact-share";

export const artifactShareStatusSchema = z.enum(ARTIFACT_SHARE_STATUSES);
export const artifactShareCreatedViaSchema = z.enum(ARTIFACT_SHARE_CREATED_VIA);
export const artifactShareUnavailableReasonSchema = z.enum([
  "sharing_disabled",
]);

/**
 * A bundle's share link as the dashboard sees it. `url` is set only while
 * `status` is `shared`; `share` describes the active share, if any.
 * `reason` explains an `unavailable` status. `expiresAt` is the bundle's
 * expiry (sharing never extends it). `shareDeclared` is true when the bundle
 * fills a result-schema field declared `share: true`, so the dashboard can
 * say it would be shared even while sharing is off on this server.
 */
export const artifactShareSchema = z.object({
  bundleId: uuidV7Schema,
  status: artifactShareStatusSchema,
  reason: artifactShareUnavailableReasonSchema.nullable(),
  url: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  shareDeclared: z.boolean(),
  share: z
    .object({
      id: uuidV7Schema,
      createdVia: artifactShareCreatedViaSchema,
      createdAt: z.iso.datetime(),
    })
    .nullable(),
});

export type ArtifactShareContract = z.infer<typeof artifactShareSchema>;

/**
 * A short-lived preview of a bundle on the content origin
 * (`<contentUrl>/p/<token>/`) and when its token stops working.
 */
export const artifactPreviewSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
});

export type ArtifactPreviewContract = z.infer<typeof artifactPreviewSchema>;

/**
 * One active share link in a project, for the settings list. `status` is the
 * link's state as of the request (`shared`, or `expired` / `unavailable`
 * when it no longer works); `url` is set only while `status` is `shared`.
 */
export const projectArtifactShareSchema = z.object({
  id: uuidV7Schema,
  bundleId: uuidV7Schema,
  bundleName: z.string(),
  taskRunId: uuidV7Schema,
  status: artifactShareStatusSchema,
  url: z.string().nullable(),
  createdVia: artifactShareCreatedViaSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const listProjectArtifactSharesResponseSchema = z.object({
  shares: z.array(projectArtifactShareSchema),
  hasMore: z.boolean(),
});

export type ProjectArtifactShareContract = z.infer<
  typeof projectArtifactShareSchema
>;
export type ListProjectArtifactSharesResponse = z.infer<
  typeof listProjectArtifactSharesResponseSchema
>;
