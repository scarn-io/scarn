import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Artifact, artifact } from "../src/definitions/artifacts";
import { findArtifactMarkers } from "../src/contracts/artifact-markers";
import { defineStep, Features } from "../src/definitions/steps";
import type { StepDefinitionSpec } from "../src/definitions/steps";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpec } from "./definition-spec-fixtures";

const reproVideo = { step: { key: "record" }, path: "reproVideo" } as const;

describe("Artifact.embed / Artifact.link", () => {
  test.concurrent("builds step markers from a step and result path", () => {
    expect(Artifact.embed(reproVideo, { caption: "Repro" })).toBe(
      "![Repro](artifact:signal/record/reproVideo)",
    );
    expect(Artifact.link(reproVideo, { label: "Trace" })).toBe(
      "[Trace](artifact:signal/record/reproVideo)",
    );
  });

  test.concurrent("builds path markers from a name or glob", () => {
    expect(Artifact.embed("shots/*.png", { caption: "Shots" })).toBe(
      "![Shots](artifact:shots/*.png)",
    );
  });

  test.concurrent("escapes captions and refs so they round-trip", () => {
    const cases = [
      { ref: "a (1).png", caption: "Look [here] \\ now" },
      { ref: "plain(1).png", caption: "x]y" },
      { ref: "dir/with <angle>.png", caption: "multi\nline" },
    ];
    for (const { ref, caption } of cases) {
      const marker = Artifact.embed(ref, { caption });
      const [found] = findArtifactMarkers(`Intro\n\n${marker}\n`);
      expect(found).toMatchObject({
        kind: "embed",
        text: caption.replace(/\s+/g, " "),
        ref: { type: "path", pattern: ref },
      });
    }
  });

  test.concurrent("works with a defined step and a nested result path", () => {
    const step = defineStep({
      key: "record",
      name: "Record",
      agentPrompt: "Record it.",
      result: z.object({
        media: z.object({ video: artifact({ accept: [".mp4"] }) }),
      }),
    });
    expect(
      Artifact.link({ step, path: "media.video" }, { label: "Video" }),
    ).toBe("[Video](artifact:signal/record/media.video)");
  });
});

describe("Features.notifications() prompt", () => {
  test.concurrent("states the marker rules", () => {
    const prompt = Features.notifications()._promptAddition;
    expect(prompt).toContain("artifact:signal/<stepKey>/<resultPath>");
    expect(prompt).toContain("artifact:<name-or-glob>");
    expect(prompt).toContain("One marker per paragraph");
    expect(prompt).toContain("Don't refer to an artifact outside its marker");
  });
});

const artifactStep = (accept: readonly string[]): StepDefinitionSpec =>
  stepSpec(
    "record",
    z.object({ reproVideo: artifact({ accept }), note: z.string() }),
  );

const commentStep = (prompt: string): StepDefinitionSpec => ({
  ...stepSpec("comment", null),
  prompt,
});

const markerIssues = (
  steps: StepDefinitionSpec[],
): Array<{ severity: string; message: string }> =>
  validateDefinitionSpecs(steps)
    .filter((issue) => issue.check === "artifact-marker")
    .map(({ severity, message }) => ({ severity, message }));

describe("validateDefinitionSpecs — artifact markers", () => {
  test.concurrent("accepts a marker for an artifact field", () => {
    const prompt = `Post ${Artifact.embed(reproVideo, { caption: "Repro" })}`;
    expect(markerIssues([artifactStep([".mp4"]), commentStep(prompt)])).toEqual(
      [],
    );
  });

  test.concurrent(
    "rejects a marker for a result path that is not an artifact",
    () => {
      const prompt = Artifact.link(
        { step: { key: "record" }, path: "note" },
        { label: "Note" },
      );
      const issues = markerIssues([
        artifactStep([".mp4"]),
        commentStep(prompt),
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain('no artifact field at "note"');
      expect(issues[0]?.message).toContain("reproVideo");
    },
  );

  test.concurrent("warns when an embedded field can never be embedded", () => {
    const prompt = Artifact.embed(reproVideo, { caption: "Repro" });
    const issues = markerIssues([
      artifactStep([".mkv", ".zip"]),
      commentStep(prompt),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.message).toContain("will always be linked");
  });

  test.concurrent("does not warn for links or embeddable fields", () => {
    const steps = [
      artifactStep([".mkv"]),
      commentStep(Artifact.link(reproVideo, { label: "Repro" })),
    ];
    expect(markerIssues(steps)).toEqual([]);
    expect(
      markerIssues([
        artifactStep([".mkv", ".mp4"]),
        commentStep(Artifact.embed(reproVideo, { caption: "Repro" })),
      ]),
    ).toEqual([]);
  });

  test.concurrent(
    "ignores the placeholder markers in the notifications prompt",
    () => {
      const prompt = Features.notifications()._promptAddition;
      expect(markerIssues([commentStep(prompt)])).toEqual([]);
    },
  );

  test.concurrent("ignores path markers", () => {
    const prompt = Artifact.embed("shots/*.png", { caption: "Shots" });
    expect(markerIssues([commentStep(prompt)])).toEqual([]);
  });
});
