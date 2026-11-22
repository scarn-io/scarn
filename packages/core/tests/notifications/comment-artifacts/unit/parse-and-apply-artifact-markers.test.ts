import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { parseArtifactMarkers } from "@/notifications/comment-artifacts/domain/parse-artifact-markers";
import { applyResolution } from "@/notifications/comment-artifacts/domain/apply-artifact-resolution";
import { matchesArtifactGlob } from "@/notifications/comment-artifacts/domain/match-artifact-glob";
import type {
  ArtifactMarkerResolution,
  ResolvedArtifactMarker,
} from "@/notifications/comment-artifacts/domain/comment-artifact-types";

const resolved: ArtifactMarkerResolution = {
  status: "resolved",
  artifact: {
    artifactId: "artifact-1",
    name: "shots/home.png",
    contentType: "image/png",
    kind: "image",
    sizeBytes: 10,
  },
};

const unavailable = (required: boolean): ArtifactMarkerResolution => ({
  status: "unavailable",
  reason: required ? "not_reported" : "no_match",
  required,
});

const resolveWith = (
  body: string,
  resolutions: ArtifactMarkerResolution[],
): ResolvedArtifactMarker[] =>
  parseArtifactMarkers(body).markers.map((marker, index) => ({
    marker,
    resolution: resolutions[index] ?? resolved,
  }));

describe("parseArtifactMarkers", () => {
  concurrentTest("parses standalone signal and path markers", () => {
    const body = [
      "Here is the repro.",
      "",
      "![Repro video](artifact:signal/record/reproVideo)",
      "",
      "[Full log](artifact:logs/*.txt)",
    ].join("\n");

    const { markers, warnings } = parseArtifactMarkers(body);

    expect(warnings).toEqual([]);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      index: 0,
      kind: "embed",
      caption: "Repro video",
      standalone: true,
      ref: { type: "signal", stepKey: "record", signalKey: "reproVideo" },
    });
    expect(markers[1]).toMatchObject({
      index: 1,
      kind: "link",
      caption: "Full log",
      standalone: true,
      ref: { type: "path", pattern: "logs/*.txt" },
    });
    const first = markers[0];
    expect(first && body.slice(first.range.start, first.range.end)).toBe(
      "![Repro video](artifact:signal/record/reproVideo)",
    );
  });

  concurrentTest("warns about a marker that shares its paragraph", () => {
    const { markers, warnings } = parseArtifactMarkers(
      "See [the log](artifact:run.log) for details.",
    );

    expect(markers[0]?.standalone).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      markerIndex: 0,
      code: "marker_not_standalone",
    });
  });

  concurrentTest("unescapes captions and angle-bracketed refs", () => {
    const { markers } = parseArtifactMarkers(
      "![a \\[b\\] c](<artifact:my shots/home (1).png>)",
    );

    expect(markers[0]).toMatchObject({
      caption: "a [b] c",
      ref: { type: "path", pattern: "my shots/home (1).png" },
    });
  });

  concurrentTest("ignores ordinary links and images", () => {
    const { markers } = parseArtifactMarkers(
      "![x](https://example.test/x.png) and [y](https://example.test)",
    );

    expect(markers).toEqual([]);
  });
});

describe("matchesArtifactGlob", () => {
  concurrentTest("matches exact names, segment wildcards and **", () => {
    expect(matchesArtifactGlob("home.png", "home.png")).toBe(true);
    expect(matchesArtifactGlob("home.png", "shots/home.png")).toBe(false);
    expect(matchesArtifactGlob("shots/*.png", "shots/home.png")).toBe(true);
    expect(matchesArtifactGlob("*.png", "shots/home.png")).toBe(false);
    expect(matchesArtifactGlob("**/*.png", "a/b/home.png")).toBe(true);
    expect(matchesArtifactGlob("**/*.png", "home.png")).toBe(true);
    expect(matchesArtifactGlob("shot?.png", "shot1.png")).toBe(true);
    expect(matchesArtifactGlob("./a.txt", "a.txt")).toBe(true);
  });
});

describe("applyResolution", () => {
  concurrentTest(
    "removes the paragraph of an unavailable optional marker",
    () => {
      const body = [
        "Intro.",
        "",
        "![Screenshot](artifact:shots/*.png)",
        "",
        "![Video](artifact:signal/record/reproVideo)",
        "",
        "Outro.",
      ].join("\n");

      const applied = applyResolution(
        body,
        resolveWith(body, [unavailable(false), resolved]),
      );

      expect(applied.body).toBe(
        [
          "Intro.",
          "",
          "![Video](artifact:signal/record/reproVideo)",
          "",
          "Outro.",
        ].join("\n"),
      );
      expect(applied.leftOut).toEqual([
        {
          markerIndex: 0,
          ref: { type: "path", pattern: "shots/*.png" },
          caption: "Screenshot",
          reason: "no_match",
        },
      ]);
    },
  );

  concurrentTest("re-indexes the kept markers against the new body", () => {
    const body = "![A](artifact:a.png)\n\n[B](artifact:b.txt)";

    const applied = applyResolution(
      body,
      resolveWith(body, [unavailable(false), resolved]),
    );

    expect(applied.body).toBe("[B](artifact:b.txt)");
    expect(applied.markers).toHaveLength(1);
    expect(applied.markers[0]?.marker).toMatchObject({
      index: 0,
      caption: "B",
      range: { start: 0, end: "[B](artifact:b.txt)".length },
    });
  });

  concurrentTest("removes a trailing marker and the space before it", () => {
    const body = "Intro.\n\n![Gone](artifact:gone.png)\n";

    const applied = applyResolution(
      body,
      resolveWith(body, [unavailable(false)]),
    );

    expect(applied.body).toBe("Intro.");
  });

  concurrentTest("removes only the marker text of an inline marker", () => {
    const body = "See [the log](artifact:run.log) for details.";

    const applied = applyResolution(
      body,
      resolveWith(body, [unavailable(false)]),
    );

    expect(applied.body).toBe("See for details.");
    expect(applied.leftOut).toHaveLength(1);
  });

  concurrentTest("keeps unavailable required markers", () => {
    const body = "![Video](artifact:signal/record/reproVideo)";

    const applied = applyResolution(
      body,
      resolveWith(body, [unavailable(true)]),
    );

    expect(applied.body).toBe(body);
    expect(applied.leftOut).toEqual([]);
    expect(applied.markers).toHaveLength(1);
  });
});
