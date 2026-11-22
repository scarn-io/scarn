const UPLOAD_FAILED_PREFIX = "upload_failed:";

const REASON_LABELS: Record<string, string> = {
  no_pipeline_run: "the comment isn't linked to a pipeline run",
  invalid_ref: "the artifact reference is invalid",
  signal_not_found: "the step didn't report this artifact",
  no_match: "no saved file matched",
  deleted: "the file was deleted",
  expired: "the file has expired",
  not_reported: "the step didn't submit the file",
  wrong_extension: "the file type isn't accepted for this field",
  not_found: "the file was never saved",
};

const UPLOAD_FAILURE_LABELS: Record<string, string> = {
  USAGE_LIMIT_EXCEEDED_STORAGE: "the upload failed (storage limit reached)",
};

/**
 * Turns an artifact marker's unavailable reason (from the draft's artifact
 * resolution, a blocked approval, or a suppressed comment) into a lowercase
 * sentence fragment, e.g. "the file has expired".
 */
export function humanizeArtifactMarkerReason(reason: string): string {
  if (reason.startsWith(UPLOAD_FAILED_PREFIX)) {
    const code = reason.slice(UPLOAD_FAILED_PREFIX.length);
    return UPLOAD_FAILURE_LABELS[code] ?? "the upload failed";
  }
  return REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}
