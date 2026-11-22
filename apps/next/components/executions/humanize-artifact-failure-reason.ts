import type { ArtifactFailureContract } from "@scarn/api/frontend-contracts";

/** Max characters shown for an unrecognized `errorMessage` fallback. */
const MAX_RAW_MESSAGE_LENGTH = 150;

const truncate = (value: string, maxLength = MAX_RAW_MESSAGE_LENGTH): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;

/** Display word for an artifact's `kind`, used in the composed failure reason. */
function artifactKindLabel(kind: ArtifactFailureContract["kind"]): string {
  switch (kind) {
    case "playwright-trace":
      return "Trace";
    case "video":
      return "Video";
    case "image":
      return "Image";
    case "generic":
      return "Artifact";
  }
}

/**
 * Maps a known `errorCode` to a lowercase, sentence-fragment reason suitable
 * for appending after "{Kind} failed to save — ". Unrecognized codes fall
 * back to the raw `errorMessage` (truncated so a verbose worker-side error
 * doesn't blow out the tooltip).
 */
function artifactFailureReasonFragment(
  errorCode: string,
  errorMessage: string,
): string {
  switch (errorCode) {
    case "USAGE_LIMIT_EXCEEDED_STORAGE":
      return "organization storage usage limit reached";
    case "UPLOAD_HTTP_ERROR":
      return "upload request failed";
    default:
      return truncate(errorMessage);
  }
}

/**
 * Builds the human-readable, kind-aware reason shown on a failed-artifact
 * row's "Upload failed" chip tooltip, e.g. "Trace failed to save —
 * organization storage usage limit reached" rather than a kind-less "An
 * artifact failed to save."
 */
export function humanizeArtifactFailureReason(
  failure: Pick<ArtifactFailureContract, "kind" | "errorCode" | "errorMessage">,
): string {
  const reason = artifactFailureReasonFragment(
    failure.errorCode,
    failure.errorMessage,
  );
  return `${artifactKindLabel(failure.kind)} failed to save — ${reason}`;
}
