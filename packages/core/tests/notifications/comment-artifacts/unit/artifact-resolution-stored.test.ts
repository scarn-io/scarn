import { describe, expect } from "bun:test";
import {
  readStoredArtifactMarkerOutcomes,
  readStoredArtifactResolution,
  readStoredArtifactResolutionJson,
} from "@/notifications/comment-artifacts/contracts/artifact-resolution-stored";
import { recordArtifactMarkerOutcome } from "@/notifications/comment-artifacts/domain/artifact-resolution-json";
import { anyJsonObjectSchema } from "@/common/contracts/json";
import { concurrentTest } from "tests/utils";
import fixtures from "../fixtures/artifact-resolution.json";

const drafted = anyJsonObjectSchema.parse(fixtures.drafted);
const approved = anyJsonObjectSchema.parse(fixtures.approved);

describe("notification_deliveries.artifact_resolution_json stored reader", () => {
  for (const [name, json] of [
    ["drafted", drafted],
    ["approved", approved],
    ["empty", null],
  ] as const) {
    concurrentTest(`reads the ${name} fixture as JSON`, () => {
      expect(readStoredArtifactResolutionJson(json)).toEqual({
        success: true,
        value: json,
      });
    });
  }

  concurrentTest("reads the drafted fixture's display sections", () => {
    expect(readStoredArtifactResolution(drafted) as unknown).toEqual({
      success: true,
      value: {
        markers: fixtures.drafted.markers,
        leftOut: fixtures.drafted.leftOut,
        warnings: fixtures.drafted.warnings,
      },
    });
  });

  concurrentTest("display sections that don't fit are unreadable", () => {
    expect(readStoredArtifactResolution({ markers: "none" }).success).toBe(
      false,
    );
  });

  concurrentTest(
    "keeps outcomes for an unknown platform and skips malformed ones",
    () => {
      expect(
        readStoredArtifactMarkerOutcomes(approved).map(
          (outcome) => outcome.markerIndex,
        ),
      ).toEqual([0, 1]);
      expect(
        readStoredArtifactMarkerOutcomes(approved).find(
          (outcome) => outcome.markerIndex === 1,
        )?.platform,
      ).toBe("retired-platform");
    },
  );

  concurrentTest("reads no outcomes from the drafted fixture", () => {
    expect(readStoredArtifactMarkerOutcomes(drafted)).toEqual([]);
    expect(readStoredArtifactMarkerOutcomes(null)).toEqual([]);
  });

  concurrentTest(
    "recording an outcome keeps the unknown-platform outcome",
    () => {
      const recorded = recordArtifactMarkerOutcome(approved, {
        markerIndex: 0,
        artifactId: "01900000-0000-7000-8000-000000000010",
        platform: "jira",
        outcome: "linked",
        externalRef: null,
      });
      expect(readStoredArtifactMarkerOutcomes(recorded)).toEqual([
        {
          markerIndex: 0,
          artifactId: "01900000-0000-7000-8000-000000000010",
          platform: "jira",
          outcome: "linked",
          externalRef: null,
        },
        {
          markerIndex: 1,
          artifactId: "01900000-0000-7000-8000-000000000011",
          platform: "retired-platform",
          outcome: "linked",
          externalRef: null,
        },
      ]);
    },
  );

  for (const [name, json] of [
    ["an array", []],
    ["a string", "resolution"],
  ] as const) {
    concurrentTest(`reports ${name} as unreadable`, () => {
      expect(readStoredArtifactResolutionJson(json).success).toBe(false);
    });
  }
});
