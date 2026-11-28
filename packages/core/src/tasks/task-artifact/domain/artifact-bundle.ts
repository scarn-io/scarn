import {
  ARTIFACT_BUNDLE_LIMITS,
  type ArtifactBundleLimits,
} from "@scarn/sdk/contracts/artifacts";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { STORAGE_RETENTION_DAYS } from "@scarn/core/billing/usage-meter/domain/storage-retention";
import { normalizeRelativeStorePath } from "./artifact-object-key";

/**
 * Artifact bundle rules: naming, root/entry path validation, and size limits.
 *
 * Path conventions:
 * - `rootPath` is a run-relative store path (the folder under
 *   `artifacts/<projectId>/<taskRunId>/`).
 * - `entryPath` and member paths are relative to the bundle root.
 * - A member file's run-relative store path is `<rootPath>/<memberPath>`
 *   (see {@link bundleMemberStorePath}).
 */

export const ARTIFACT_BUNDLE_STATUSES = ["pending", "ready", "failed"] as const;
export type ArtifactBundleStatus = (typeof ARTIFACT_BUNDLE_STATUSES)[number];

export const DEFAULT_ARTIFACT_BUNDLE_ENTRY = "index.html";

/** A bundle still `pending` this long after creation is swept as `failed`. */
export const STALE_PENDING_ARTIFACT_BUNDLE_MS = 24 * 60 * 60 * 1_000;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * When a bundle expires: `retentionDays` after it was created. Its members
 * are created after the bundle, so this is the moment the first of them can
 * expire (see `clearExpiredArtifacts`), after which the bundle is unusable.
 */
export const artifactBundleExpiresAt = (
  bundle: { createdAt: string | Date },
  retentionDays: number = STORAGE_RETENTION_DAYS,
): Date =>
  new Date(new Date(bundle.createdAt).getTime() + retentionDays * MS_PER_DAY);

/**
 * Has the bundle expired as of `now`? True once `clearExpiredArtifacts` has
 * marked it (`expiredAt`), or once it has reached
 * {@link artifactBundleExpiresAt} (matching that sweep's inclusive cutoff),
 * so callers agree with the sweep even before it next runs.
 */
export const isArtifactBundleExpired = (
  bundle: { createdAt: string | Date; expiredAt: string | Date | null },
  now: Date,
  retentionDays: number = STORAGE_RETENTION_DAYS,
): boolean =>
  bundle.expiredAt !== null ||
  now.getTime() >= artifactBundleExpiresAt(bundle, retentionDays).getTime();

/** Default bundle limits (plan decision 16), shared with the SDK. Self-hosters may override via env. */
export { ARTIFACT_BUNDLE_LIMITS, type ArtifactBundleLimits };

export const ARTIFACT_BUNDLE_LIMIT_ENV_VARS = {
  maxFiles: "ARTIFACT_BUNDLE_MAX_FILES",
  maxFileBytes: "ARTIFACT_BUNDLE_MAX_FILE_BYTES",
  maxBundleBytes: "ARTIFACT_BUNDLE_MAX_BYTES",
} as const satisfies Record<keyof ArtifactBundleLimits, string>;

const parseLimitOverride = (
  envName: string,
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CoreValidationError(
      `${envName} must be a positive integer, got: ${raw}`,
      "INVALID_ARTIFACT_BUNDLE_LIMIT",
    );
  }
  return value;
};

/**
 * Resolve bundle limits, applying any positive-integer overrides from `env`
 * (see {@link ARTIFACT_BUNDLE_LIMIT_ENV_VARS}). Unset or blank vars keep the
 * defaults; malformed values throw.
 */
export const resolveArtifactBundleLimits = (
  env: Record<string, string | undefined> = {},
): ArtifactBundleLimits => ({
  maxFiles: parseLimitOverride(
    ARTIFACT_BUNDLE_LIMIT_ENV_VARS.maxFiles,
    env[ARTIFACT_BUNDLE_LIMIT_ENV_VARS.maxFiles],
    ARTIFACT_BUNDLE_LIMITS.maxFiles,
  ),
  maxFileBytes: parseLimitOverride(
    ARTIFACT_BUNDLE_LIMIT_ENV_VARS.maxFileBytes,
    env[ARTIFACT_BUNDLE_LIMIT_ENV_VARS.maxFileBytes],
    ARTIFACT_BUNDLE_LIMITS.maxFileBytes,
  ),
  maxBundleBytes: parseLimitOverride(
    ARTIFACT_BUNDLE_LIMIT_ENV_VARS.maxBundleBytes,
    env[ARTIFACT_BUNDLE_LIMIT_ENV_VARS.maxBundleBytes],
    ARTIFACT_BUNDLE_LIMITS.maxBundleBytes,
  ),
});

/** Validate a bundle name: exactly one path segment, returned trimmed. */
export const normalizeArtifactBundleName = (name: string): string => {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw new CoreValidationError(
      `Bundle name must be a single path segment: ${name}`,
      "INVALID_ARTIFACT_BUNDLE_NAME",
    );
  }
  return trimmed;
};

/** Validate an entry page path (relative to the bundle root); it must end in `.html`. */
export const normalizeArtifactBundleEntry = (entryPath: string): string => {
  const normalized = normalizeRelativeStorePath(entryPath);
  if (!normalized.toLowerCase().endsWith(".html")) {
    throw new CoreValidationError(
      `Bundle entry must be an .html file: ${entryPath}`,
      "INVALID_ARTIFACT_BUNDLE_ENTRY",
    );
  }
  return normalized;
};

export type ArtifactBundleSpec = {
  name: string;
  rootPath: string;
  entryPath: string;
};

/**
 * Validate and normalize a bundle's name, root and entry. `entryPath` is
 * relative to the root and defaults to `index.html`; because it is a
 * normalized relative path with no `..`, it always lies inside the root.
 */
export const parseArtifactBundleSpec = (input: {
  name: string;
  rootPath: string;
  entryPath?: string;
}): ArtifactBundleSpec => ({
  name: normalizeArtifactBundleName(input.name),
  rootPath: normalizeRelativeStorePath(input.rootPath),
  entryPath: normalizeArtifactBundleEntry(
    input.entryPath ?? DEFAULT_ARTIFACT_BUNDLE_ENTRY,
  ),
});

/** The run-relative store path of a member at root-relative `memberPath`. */
export const bundleMemberStorePath = (
  rootPath: string,
  memberPath: string,
): string =>
  `${normalizeRelativeStorePath(rootPath)}/${normalizeRelativeStorePath(memberPath)}`;

/**
 * The root-relative path of a run-relative store path, or `null` when the
 * path does not lie strictly inside the bundle root.
 */
export const bundleRelativePath = (
  rootPath: string,
  relativeStorePath: string,
): string | null => {
  const root = normalizeRelativeStorePath(rootPath);
  const path = normalizeRelativeStorePath(relativeStorePath);
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
};

/** Reject a single member file larger than the per-file limit. */
export const assertBundleMemberSize = (
  sizeBytes: number,
  limits: ArtifactBundleLimits,
): void => {
  if (sizeBytes > limits.maxFileBytes) {
    throw new CoreValidationError(
      `Bundle member is ${String(sizeBytes)} bytes; the limit is ${String(limits.maxFileBytes)}`,
      "ARTIFACT_BUNDLE_FILE_TOO_LARGE",
      { sizeBytes, maxFileBytes: limits.maxFileBytes },
    );
  }
};

export type BundleManifestEntry = { path: string; sizeBytes: number };
export type BundleMemberSummary = { path: string; sizeBytes: number | null };
export type BundleTotals = { fileCount: number; sizeBytes: number };

const manifestError = (
  message: string,
  code: string,
  meta?: Record<string, unknown>,
) => new CoreValidationError(message, code, meta);

/**
 * Check the members recorded for a bundle against the manifest the client
 * posted at finalize, and return the bundle's totals. Paths are relative to
 * the bundle root. Every manifest path must have a recorded member, no member
 * may lie outside the manifest, sizes given in the manifest must match, the
 * entry page must be present and the bundle must fit the limits. Throws a
 * {@link CoreValidationError} describing the first mismatch.
 */
export const checkBundleManifest = (input: {
  entryPath: string;
  manifest: readonly BundleManifestEntry[];
  members: readonly BundleMemberSummary[];
  limits: ArtifactBundleLimits;
}): BundleTotals => {
  const { entryPath, limits } = input;

  const manifest = new Map<string, number>();
  for (const entry of input.manifest) {
    const path = normalizeRelativeStorePath(entry.path);
    if (manifest.has(path)) {
      throw manifestError(
        `Bundle manifest lists ${path} more than once`,
        "ARTIFACT_BUNDLE_MANIFEST_DUPLICATE",
        { path },
      );
    }
    manifest.set(path, entry.sizeBytes);
  }

  if (manifest.size > limits.maxFiles) {
    throw manifestError(
      `Bundle has ${String(manifest.size)} files; the limit is ${String(limits.maxFiles)}`,
      "ARTIFACT_BUNDLE_TOO_MANY_FILES",
      { fileCount: manifest.size, maxFiles: limits.maxFiles },
    );
  }

  if (!manifest.has(entryPath)) {
    throw manifestError(
      `Bundle manifest does not include the entry page ${entryPath}`,
      "ARTIFACT_BUNDLE_ENTRY_MISSING",
      { entryPath },
    );
  }

  const members = new Map<string, number>();
  for (const member of input.members) {
    if (!members.has(member.path)) {
      members.set(member.path, member.sizeBytes ?? 0);
    }
  }

  const missing = [...manifest.keys()].filter((path) => !members.has(path));
  if (missing.length > 0) {
    throw manifestError(
      `Bundle members were not recorded: ${missing.slice(0, 10).join(", ")}`,
      "ARTIFACT_BUNDLE_MEMBER_MISSING",
      { missing: missing.slice(0, 100) },
    );
  }

  const extra = [...members.keys()].filter((path) => !manifest.has(path));
  if (extra.length > 0) {
    throw manifestError(
      `Recorded bundle members are not in the manifest: ${extra.slice(0, 10).join(", ")}`,
      "ARTIFACT_BUNDLE_MEMBER_UNEXPECTED",
      { unexpected: extra.slice(0, 100) },
    );
  }

  let sizeBytes = 0;
  for (const [path, recordedSize] of members) {
    const declaredSize = manifest.get(path);
    if (declaredSize !== recordedSize) {
      throw manifestError(
        `Bundle member ${path} is ${String(recordedSize)} bytes but the manifest says ${String(declaredSize)}`,
        "ARTIFACT_BUNDLE_MEMBER_SIZE_MISMATCH",
        { path, recordedSize, declaredSize },
      );
    }
    assertBundleMemberSize(recordedSize, limits);
    sizeBytes += recordedSize;
  }

  if (sizeBytes > limits.maxBundleBytes) {
    throw manifestError(
      `Bundle is ${String(sizeBytes)} bytes; the limit is ${String(limits.maxBundleBytes)}`,
      "ARTIFACT_BUNDLE_TOO_LARGE",
      { sizeBytes, maxBundleBytes: limits.maxBundleBytes },
    );
  }

  return { fileCount: members.size, sizeBytes };
};
