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
  RunArtifactBundle,
  RunArtifactResolution,
} from "@/notifications/comment-artifacts/application/comment-artifact-reader";
import { buildArtifactResolutionJson } from "@/notifications/comment-artifacts/domain/artifact-resolution-json";
import { readStoredArtifactResolution } from "@/notifications/comment-artifacts/contracts/artifact-resolution-stored";
import { createArtifactSharingConfig } from "@/tasks/artifact-share/domain/artifact-sharing-config";
import { verifyShareToken } from "@/tasks/artifact-share/domain/share-token";

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

const runBundle = (
  overrides: Partial<RunArtifactBundle> = {},
): RunArtifactBundle => ({
  id: createUuidV7(),
  name: "report",
  fieldPath: null,
  status: "ready",
  createdAt: new Date(),
  expiredAt: null,
  deletedAt: null,
  activeShareId: null,
  ...overrides,
});

const fakeReader = (
  artifacts: RunArtifact[],
  resolutions: Record<string, RunArtifactResolution> = {},
  bundles: RunArtifactBundle[] = [],
): CommentArtifactReader => ({
  findLatestStepArtifact: ({ stepKey, resultPath }) =>
    Promise.resolve(resolutions[`${stepKey}/${resultPath}`] ?? null),
  listRunArtifacts: () => Promise.resolve(artifacts),
  findLatestStepBundle: ({ stepKey, fieldPath }) =>
    Promise.resolve(
      bundles.find(
        (bundle) => stepKey === "reproduce" && bundle.fieldPath === fieldPath,
      ) ?? null,
    ),
  listRunBundles: () => Promise.resolve(bundles),
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

describe("artifact markers that point at bundles", () => {
  const projectId = createUuidV7();
  const sharing = createArtifactSharingConfig({
    contentUrl: "https://content.test/",
    shareSecret: "share-secret",
  });

  const renderBundles = async (
    body: string,
    bundles: RunArtifactBundle[],
    artifactSharingConfig = sharing,
  ) => {
    const markers = await resolveArtifactMarkers(
      parseArtifactMarkers(body).markers,
      { pipelineRunId: createUuidV7() },
      {
        commentArtifactReader: fakeReader([], {}, bundles),
        artifactSharingConfig,
      },
    );
    const rendered = await new LinkOnlyCommentArtifactRenderer(
      "github",
      "https://app.test",
    ).render({ body, markers, projectId });
    return { markers, rendered };
  };

  const bundlePage = (bundleId: UuidV7) =>
    `https://app.test/projects/${projectId}/artifact-bundles/${bundleId}`;

  concurrentTest(
    "links a signal marker to a shared bundle's share URL",
    async () => {
      const shareId = createUuidV7();
      const bundle = runBundle({ fieldPath: "report", activeShareId: shareId });
      const { markers, rendered } = await renderBundles(
        "[Full report](artifact:signal/reproduce/report)",
        [bundle],
      );

      expect(markers[0]?.resolution).toMatchObject({
        status: "resolved",
        artifact: { artifactId: bundle.id, name: "report", kind: "bundle" },
      });
      const url = /\((.+)\)/.exec(rendered.body)?.[1] ?? "";
      expect(url).toStartWith("https://content.test/s/");
      expect(url).toEndWith("/");
      const token = url.slice("https://content.test/s/".length, -1);
      expect(verifyShareToken("share-secret", token)).toBe(shareId);
      expect(rendered.body).toBe(`[Full report](${url})`);
    },
  );

  concurrentTest(
    "links a signal marker to a private bundle's page",
    async () => {
      const bundle = runBundle({ fieldPath: "report" });
      const { rendered } = await renderBundles(
        "[Full report](artifact:signal/reproduce/report)",
        [bundle],
      );

      expect(rendered.body).toBe(`[Full report](${bundlePage(bundle.id)})`);
    },
  );

  concurrentTest(
    "falls back to the bundle page when sharing is disabled",
    async () => {
      const bundle = runBundle({
        fieldPath: "report",
        activeShareId: createUuidV7(),
      });
      const { rendered } = await renderBundles(
        "[Full report](artifact:signal/reproduce/report)",
        [bundle],
        createArtifactSharingConfig({}),
      );

      expect(rendered.body).toBe(`[Full report](${bundlePage(bundle.id)})`);
    },
  );

  concurrentTest(
    "links a path marker with a trailing slash to an undeclared bundle",
    async () => {
      const bundle = runBundle({ name: "coverage" });
      const { rendered } = await renderBundles(
        "See [coverage](artifact:coverage/).",
        [runBundle({ name: "other" }), bundle],
      );

      expect(rendered.body).toBe(`See [coverage](${bundlePage(bundle.id)}).`);
    },
  );

  concurrentTest("renders an embed marker on a bundle as a link", async () => {
    const bundle = runBundle({ name: "site" });
    const { rendered } = await renderBundles(
      "Intro.\n\n![The site](artifact:site/)\n\nOutro.",
      [bundle],
    );

    expect(rendered.body).toBe(
      `Intro.\n\n[The site](${bundlePage(bundle.id)})\n\nOutro.`,
    );
    expect(rendered.outcomes[0]).toMatchObject({
      artifactId: bundle.id,
      outcome: "linked",
    });
  });

  concurrentTest(
    "reports deleted, expired and unready bundles as unavailable",
    async () => {
      const results = await resolveArtifactMarkers(
        parseArtifactMarkers(
          [
            "[A](artifact:signal/reproduce/deleted)",
            "[B](artifact:signal/reproduce/expired)",
            "[C](artifact:signal/reproduce/pending)",
            "[D](artifact:gone/)",
            "[E](artifact:old/)",
          ].join("\n\n"),
        ).markers,
        { pipelineRunId: createUuidV7() },
        {
          commentArtifactReader: fakeReader([], {}, [
            runBundle({ fieldPath: "deleted", deletedAt: new Date() }),
            runBundle({ fieldPath: "expired", expiredAt: new Date() }),
            runBundle({ fieldPath: "pending", status: "pending" }),
            runBundle({ name: "old", expiredAt: new Date() }),
          ]),
        },
      );

      expect(results.map(({ resolution }) => resolution)).toEqual([
        { status: "unavailable", reason: "deleted", required: true },
        { status: "unavailable", reason: "expired", required: true },
        { status: "unavailable", reason: "bundle_not_ready", required: true },
        { status: "unavailable", reason: "no_match", required: false },
        { status: "unavailable", reason: "expired", required: false },
      ]);
    },
  );

  concurrentTest(
    "stores a resolved bundle without its share link, readable as before",
    async () => {
      const bundle = runBundle({
        fieldPath: "report",
        activeShareId: createUuidV7(),
      });
      const { markers } = await renderBundles(
        "[Full report](artifact:signal/reproduce/report)",
        [bundle],
      );
      const json = buildArtifactResolutionJson({ markers, warnings: [] });

      expect(JSON.stringify(json)).not.toContain("content.test");
      const read = readStoredArtifactResolution(json);
      expect(read.success).toBe(true);
      expect(read.success && read.value.markers[0]?.artifact).toEqual({
        artifactId: bundle.id,
        name: "report",
        contentType: null,
        kind: "bundle",
        sizeBytes: null,
      });
    },
  );
});
