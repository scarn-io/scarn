import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { parseArtifactMarkers } from "@/notifications/comment-artifacts/domain/parse-artifact-markers";
import { resolveArtifactMarkers } from "@/notifications/comment-artifacts/application/resolve-artifact-markers";
import { LinkOnlyCommentArtifactRenderer } from "@/notifications/comment-artifacts/application/comment-artifact-renderer";
import { prepareCommentDraftArtifacts } from "@/notifications/comment-artifacts/application/prepare-comment-draft-artifacts";
import type {
  CommentArtifactReader,
  RunArtifact,
  RunArtifactResolution,
} from "@/notifications/comment-artifacts/application/comment-artifact-reader";

const runArtifact = (overrides: Partial<RunArtifact> = {}): RunArtifact => ({
  id: createUuidV7(),
  relativeStorePath: "shots/home.png",
  contentType: "image/png",
  kind: "image",
  sizeBytes: 42,
  storeRef: "s3://bucket/key",
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const fakeReader = (
  artifacts: RunArtifact[],
  resolutions: Record<string, RunArtifactResolution> = {},
): CommentArtifactReader => ({
  findLatestStepArtifact: ({ stepKey, resultPath }) =>
    Promise.resolve(resolutions[`${stepKey}/${resultPath}`] ?? null),
  listRunArtifacts: () => Promise.resolve(artifacts),
});

const artifactResolution = (
  artifactId: UuidV7 | null,
): RunArtifactResolution => ({
  artifactId,
  unavailableReason: artifactId ? null : "not_reported",
});

const resolve = (body: string, reader: CommentArtifactReader) =>
  resolveArtifactMarkers(
    parseArtifactMarkers(body).markers,
    { pipelineRunId: createUuidV7() },
    { commentArtifactReader: reader },
  );

describe("resolveArtifactMarkers", () => {
  concurrentTest("resolves a signal ref to its artifact", async () => {
    const video = runArtifact({ relativeStorePath: "repro.mp4" });
    const [entry] = await resolve(
      "![Video](artifact:signal/record/reproVideo)",
      fakeReader([video], {
        "record/reproVideo": artifactResolution(video.id),
      }),
    );

    expect(entry?.resolution).toEqual({
      status: "resolved",
      artifact: {
        artifactId: video.id,
        name: "repro.mp4",
        contentType: "image/png",
        kind: "image",
        sizeBytes: 42,
      },
    });
  });

  concurrentTest("reports why a required signal ref is missing", async () => {
    const deleted = runArtifact({ deletedAt: new Date() });
    const results = await resolve(
      [
        "![A](artifact:signal/record/missing)",
        "![B](artifact:signal/record/notReported)",
        "![C](artifact:signal/record/deleted)",
      ].join("\n\n"),
      fakeReader([deleted], {
        "record/notReported": artifactResolution(null),
        "record/deleted": artifactResolution(deleted.id),
      }),
    );

    expect(results.map(({ resolution }) => resolution)).toEqual([
      { status: "unavailable", reason: "signal_not_found", required: true },
      { status: "unavailable", reason: "not_reported", required: true },
      { status: "unavailable", reason: "deleted", required: true },
    ]);
  });

  concurrentTest(
    "picks the newest non-expired, non-deleted glob match",
    async () => {
      const newestExpired = runArtifact({ storeRef: null });
      const deleted = runArtifact({ deletedAt: new Date() });
      const winner = runArtifact({ relativeStorePath: "shots/b.png" });
      const older = runArtifact({ relativeStorePath: "shots/a.png" });
      const [entry] = await resolve(
        "![Shot](artifact:shots/*.png)",
        fakeReader([newestExpired, deleted, winner, older]),
      );

      expect(entry?.resolution).toMatchObject({
        status: "resolved",
        artifact: { artifactId: winner.id },
      });
    },
  );

  concurrentTest("marks an unmatched path ref optional", async () => {
    const [entry] = await resolve(
      "[Log](artifact:missing.txt)",
      fakeReader([]),
    );

    expect(entry?.resolution).toEqual({
      status: "unavailable",
      reason: "no_match",
      required: false,
    });
  });
});

describe("prepareCommentDraftArtifacts", () => {
  concurrentTest(
    "suppresses the draft when a required marker is unavailable",
    async () => {
      const prepared = await prepareCommentDraftArtifacts(
        "Body.\n\n![Video](artifact:signal/record/reproVideo)",
        { pipelineRunId: createUuidV7() },
        { commentArtifactReader: fakeReader([]) },
      );

      expect(prepared).toEqual({
        status: "suppressed",
        commentSuppressed: {
          reason: "signal_not_found",
          artifact: {
            stepKey: "record",
            signalKey: "reproVideo",
            caption: "Video",
          },
        },
      });
    },
  );

  concurrentTest("leaves a body without markers untouched", async () => {
    const prepared = await prepareCommentDraftArtifacts(
      "Just text.",
      { pipelineRunId: null },
      { commentArtifactReader: fakeReader([]) },
    );

    expect(prepared).toEqual({
      status: "ready",
      body: "Just text.",
      artifactResolutionJson: null,
    });
  });
});

describe("LinkOnlyCommentArtifactRenderer", () => {
  const projectId = createUuidV7();

  const render = async (body: string, artifact: RunArtifact) => {
    const markers = await resolve(
      body,
      fakeReader([artifact], {
        "record/reproVideo": artifactResolution(artifact.id),
      }),
    );
    return new LinkOnlyCommentArtifactRenderer(
      "github",
      "https://app.test/",
    ).render({ body, markers, projectId });
  };

  const pageUrl = (artifactId: UuidV7) =>
    `https://app.test/projects/${projectId}/artifacts/${artifactId}`;

  concurrentTest(
    "renders a standalone embed as its caption, then a link",
    async () => {
      const video = runArtifact({ relativeStorePath: "media/repro.mp4" });
      const rendered = await render(
        "Intro.\n\n![Repro video](artifact:signal/record/reproVideo)\n\nOutro.",
        video,
      );

      expect(rendered.body).toBe(
        `Intro.\n\nRepro video\n[View repro.mp4 in Scarn](${pageUrl(video.id)})\n\nOutro.`,
      );
      expect(rendered.outcomes).toEqual([
        {
          markerIndex: 0,
          artifactId: video.id,
          platform: "github",
          outcome: "linked",
          externalRef: null,
        },
      ]);
    },
  );

  concurrentTest("renders a link marker with its label", async () => {
    const log = runArtifact({ relativeStorePath: "run.log" });
    const rendered = await render("See [the log](artifact:run.log).", log);

    expect(rendered.body).toBe(`See [the log](${pageUrl(log.id)}).`);
  });
});
