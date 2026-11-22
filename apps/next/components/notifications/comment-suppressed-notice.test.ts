import { describe, expect, test } from "bun:test";
import { readCommentSuppressed } from "./comment-suppressed-notice";
import { humanizeArtifactMarkerReason } from "@/components/artifacts/artifact-marker-reason";

describe("readCommentSuppressed", () => {
  test("reads a signal-ref suppression", () => {
    expect(
      readCommentSuppressed({
        payloadJson: {
          commentSuppressed: {
            reason: "not_reported",
            artifact: {
              stepKey: "record",
              signalKey: "reproVideo",
              caption: "Repro video",
            },
          },
        },
      }),
    ).toEqual({
      reason: "not_reported",
      caption: "Repro video",
      stepKey: "record",
    });
  });

  test("reads a path-ref suppression without a step", () => {
    expect(
      readCommentSuppressed({
        payloadJson: {
          commentSuppressed: {
            reason: "no_match",
            artifact: { pattern: "shots/*.png", caption: "Screenshot" },
          },
        },
      }),
    ).toEqual({ reason: "no_match", caption: "Screenshot", stepKey: null });
  });

  test("returns null when the comment wasn't suppressed", () => {
    expect(readCommentSuppressed({ payloadJson: null })).toBeNull();
    expect(
      readCommentSuppressed({ payloadJson: { source: "test" } }),
    ).toBeNull();
  });
});

describe("humanizeArtifactMarkerReason", () => {
  test("maps known reasons and upload failures", () => {
    expect(humanizeArtifactMarkerReason("expired")).toBe(
      "the file has expired",
    );
    expect(
      humanizeArtifactMarkerReason(
        "upload_failed:USAGE_LIMIT_EXCEEDED_STORAGE",
      ),
    ).toBe("the upload failed (storage limit reached)");
    expect(humanizeArtifactMarkerReason("upload_failed:OTHER")).toBe(
      "the upload failed",
    );
    expect(humanizeArtifactMarkerReason("something_new")).toBe("something new");
  });
});
