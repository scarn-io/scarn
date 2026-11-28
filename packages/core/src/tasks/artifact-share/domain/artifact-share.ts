import { CoreError } from "@scarn/core/lib/errors";

export const ARTIFACT_SHARE_CREATED_VIA = ["person", "step"] as const;
export type ArtifactShareCreatedVia =
  (typeof ARTIFACT_SHARE_CREATED_VIA)[number];

/**
 * What a bundle's share link looks like to the dashboard:
 * - `private`: no active share;
 * - `shared`: an active share whose link works;
 * - `expired`: the bundle aged past retention, so no link can work;
 * - `deleted`: the bundle was deleted;
 * - `unavailable`: sharing is not configured on this server (decision 14).
 */
export const ARTIFACT_SHARE_STATUSES = [
  "private",
  "shared",
  "expired",
  "deleted",
  "unavailable",
] as const;
export type ArtifactShareStatus = (typeof ARTIFACT_SHARE_STATUSES)[number];

/** Sharing is disabled because the content origin or share secret is unset. */
export class ArtifactSharingDisabledError extends CoreError {
  constructor() {
    super({
      code: "ARTIFACT_SHARING_DISABLED",
      message:
        "Artifact sharing is disabled: SCARN_ARTIFACT_CONTENT_URL and ARTIFACT_SHARE_SECRET must both be set",
      status: 409,
    });
  }
}

/** Only a `ready`, unexpired bundle can be shared. */
export class ArtifactBundleNotShareableError extends CoreError {
  constructor(
    bundleId: string,
    reason: "not_ready" | "expired",
    meta?: Record<string, unknown>,
  ) {
    super({
      code:
        reason === "expired"
          ? "ARTIFACT_BUNDLE_EXPIRED"
          : "ARTIFACT_BUNDLE_NOT_READY",
      message:
        reason === "expired"
          ? `Artifact bundle ${bundleId} has expired and cannot be shared`
          : `Artifact bundle ${bundleId} is not ready and cannot be shared`,
      status: 409,
      meta: { bundleId, ...meta },
    });
  }
}
