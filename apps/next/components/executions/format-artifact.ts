import { formatBytes } from "./format-bytes";
import type { ArtifactContract } from "@scarn/api/frontend-contracts";

/** Returns the trailing path segment (basename) of a relative store path. */
export function basename(relativeStorePath: string): string {
  const segments = relativeStorePath.split("/");
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : relativeStorePath;
}

/**
 * Builds the secondary meta line: formatted size, plus content type when set.
 * `sizeBytes` is null once an artifact has expired (Phase 2) — the size
 * segment is simply omitted in that case. Dedicated "expired" messaging is
 * surfaced separately: an "Expired" chip and dimmed row (keyed off
 * `storeRef === null`) in the list, and a distinct download-time error
 * message from the hook (see `use-task-run-artifacts.ts`).
 *
 * Typed against a `Pick` of `ArtifactContract` (rather than the full
 * contract) so it also accepts `ProjectArtifactContract` — a strict superset
 * that adds `nodeKey` — without a cast, for reuse by
 * `project-artifacts-panel.tsx`.
 */
export function formatArtifactMeta(
  artifact: Pick<ArtifactContract, "sizeBytes" | "contentType">,
): string {
  const size =
    artifact.sizeBytes === null ? null : formatBytes(artifact.sizeBytes);
  if (size && artifact.contentType) {
    return `${size} · ${artifact.contentType}`;
  }
  return size ?? artifact.contentType ?? "";
}
