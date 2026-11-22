import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { parseArtifactMarkers } from "@/notifications/comment-artifacts/domain/parse-artifact-markers";
import type {
  ArtifactMarkerOutcome,
  ResolvedArtifactMarker,
  ResolvedCommentArtifact,
} from "@/notifications/comment-artifacts/domain/comment-artifact-types";
import {
  JiraCommentArtifactRenderer,
  formatJiraAttachmentRef,
  parseJiraAttachmentRef,
} from "@/integrations/jira-ingest/infra/jira-comment-artifact-renderer";
import {
  adfLinkMark,
  adfText,
} from "@/integrations/jira-ingest/infra/markdown-to-adf";
import { concurrentTest } from "tests/utils";

const BASE_URL = "https://acme.atlassian.net";
const MEDIA_ID = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const LOCATION = `https://api.media.atlassian.com/file/${MEDIA_ID}/binary?token=t&client=11111111-2222-4333-8444-555555555555`;
const projectId = createUuidV7();

const artifact = (name: string): ResolvedCommentArtifact => ({
  artifactId: createUuidV7(),
  name,
  contentType: null,
  kind: "generic",
  sizeBytes: 3,
});

const resolveAll = (
  body: string,
  artifacts: ResolvedCommentArtifact[],
): ResolvedArtifactMarker[] =>
  parseArtifactMarkers(body).markers.map((marker, index) => {
    const resolved = artifacts[index];
    if (!resolved) throw new Error("missing artifact");
    return { marker, resolution: { status: "resolved", artifact: resolved } };
  });

const requestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

type Harness = {
  uploads: string[];
  lookups: number;
  reads: string[];
  recorded: ArtifactMarkerOutcome[];
  /** How many media lookups had run when each outcome was recorded. */
  lookupsAtRecord: number[];
};

const makeRenderer = (
  options: { redirect?: boolean; uploadStatus?: number; bytes?: boolean } = {},
) => {
  const { redirect = true, uploadStatus = 200, bytes = true } = options;
  const harness: Harness = {
    uploads: [],
    lookups: 0,
    reads: [],
    recorded: [],
    lookupsAtRecord: [],
  };
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/attachments")) {
      const file = (init?.body as FormData).get("file") as File;
      harness.uploads.push(`${file.name}|${file.type}`);
      return Promise.resolve(
        uploadStatus === 200
          ? Response.json([{ id: String(harness.uploads.length + 100) }])
          : new Response("no", { status: uploadStatus }),
      );
    }
    harness.lookups += 1;
    return Promise.resolve(
      new Response(null, {
        status: redirect ? 303 : 200,
        headers: redirect ? { location: LOCATION } : {},
      }),
    );
  }) as typeof fetch;

  const renderer = new JiraCommentArtifactRenderer({
    connection: { baseUrl: BASE_URL, email: "me@acme.test", apiToken: "t" },
    issueKey: "PROJ-1",
    appBaseUrl: "https://app.test",
    readArtifactBytes: (resolved) => {
      harness.reads.push(resolved.artifactId);
      return Promise.resolve(
        bytes ? { bytes: new Uint8Array([1, 2, 3]), contentType: null } : null,
      );
    },
    fetchImpl,
    sleep: () => Promise.resolve(),
  });

  const render = (
    body: string,
    artifacts: ResolvedCommentArtifact[],
    priorOutcomes: ArtifactMarkerOutcome[] = [],
  ) =>
    renderer.render({
      body,
      markers: resolveAll(body, artifacts),
      projectId,
      priorOutcomes,
      onOutcome: (outcome) => {
        harness.recorded.push(outcome);
        harness.lookupsAtRecord.push(harness.lookups);
        return Promise.resolve();
      },
    });
  return { harness, render };
};

const pageUrl = (artifactId: string) =>
  `https://app.test/projects/${projectId}/artifacts/${artifactId}`;

describe("JiraCommentArtifactRenderer", () => {
  concurrentTest(
    "embeds a standalone PNG as caption + mediaSingle and records it before returning",
    async () => {
      const { harness, render } = makeRenderer();
      const shot = artifact("shots/home.png");

      const rendered = await render("![Home page](artifact:home.png)", [shot]);

      expect(harness.uploads).toEqual(["home.png|image/png"]);
      expect(rendered.document).toEqual({
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [adfText("Home page")] },
          {
            type: "mediaSingle",
            attrs: { layout: "center" },
            content: [
              {
                type: "media",
                attrs: {
                  type: "file",
                  id: MEDIA_ID,
                  collection: "",
                  alt: "Home page",
                },
              },
            ],
          },
        ],
      });
      const expected: ArtifactMarkerOutcome = {
        markerIndex: 0,
        artifactId: shot.artifactId,
        platform: "jira",
        outcome: "embedded",
        externalRef: `jira-attachment:101/media:${MEDIA_ID}`,
      };
      expect(harness.recorded).toEqual([
        {
          ...expected,
          outcome: "linked",
          externalRef: "jira-attachment:101",
        },
        expected,
      ]);
      expect(rendered.outcomes).toEqual([expected]);
      expect(rendered.body).toContain(`(${pageUrl(shot.artifactId)})`);
    },
  );

  concurrentTest(
    "links to the Jira attachment when no media UUID is found",
    async () => {
      const { harness, render } = makeRenderer({ redirect: false });
      const video = artifact("repro.webm");

      const rendered = await render("![Repro](artifact:repro.webm)", [video]);

      expect(harness.uploads).toEqual(["repro.webm|video/webm"]);
      expect(rendered.document?.["content"]).toEqual([
        {
          type: "paragraph",
          content: [
            adfText("Repro"),
            { type: "hardBreak" },
            adfText("View repro.webm", [
              adfLinkMark(`${BASE_URL}/rest/api/3/attachment/content/101`),
            ]),
          ],
        },
      ]);
      expect(rendered.outcomes).toMatchObject([
        { outcome: "linked", externalRef: "jira-attachment:101" },
      ]);
    },
  );

  concurrentTest(
    "links non-embeddable files and link markers to Scarn without uploading",
    async () => {
      const { harness, render } = makeRenderer();
      const trace = artifact("trace.zip");
      const log = artifact("run.log");

      const rendered = await render(
        "![Trace](artifact:trace.zip)\n\nSee [the log](artifact:run.log).",
        [trace, log],
      );

      expect(harness.uploads).toEqual([]);
      expect(rendered.document?.["content"]).toEqual([
        {
          type: "paragraph",
          content: [
            adfText("Trace"),
            { type: "hardBreak" },
            adfText("View trace.zip in Scarn", [
              adfLinkMark(pageUrl(trace.artifactId)),
            ]),
          ],
        },
        {
          type: "paragraph",
          content: [
            adfText("See "),
            adfText("the log", [adfLinkMark(pageUrl(log.artifactId))]),
            adfText("."),
          ],
        },
      ]);
      expect(rendered.outcomes.map((outcome) => outcome.outcome)).toEqual([
        "linked",
        "linked",
      ]);
      expect(harness.recorded).toEqual([]);
    },
  );

  concurrentTest("links an embeddable file that isn't standalone", async () => {
    const { harness, render } = makeRenderer();
    const shot = artifact("a.png");

    const rendered = await render("Look: ![Shot](artifact:a.png)", [shot]);

    expect(harness.uploads).toEqual([]);
    expect(rendered.document?.["content"]).toEqual([
      {
        type: "paragraph",
        content: [
          adfText("Look: "),
          adfText("Shot "),
          adfText("View a.png in Scarn", [
            adfLinkMark(pageUrl(shot.artifactId)),
          ]),
        ],
      },
    ]);
  });

  concurrentTest(
    "reuses a stored outcome instead of uploading again",
    async () => {
      const { harness, render } = makeRenderer();
      const shot = artifact("a.gif");

      const rendered = await render(
        "![Anim](artifact:a.gif)",
        [shot],
        [
          {
            markerIndex: 0,
            artifactId: shot.artifactId,
            platform: "jira",
            outcome: "embedded",
            externalRef: `jira-attachment:77/media:${MEDIA_ID}`,
          },
        ],
      );

      expect(harness.uploads).toEqual([]);
      expect(harness.reads).toEqual([]);
      expect(harness.recorded).toEqual([]);
      expect(rendered.outcomes).toMatchObject([
        {
          outcome: "embedded",
          externalRef: `jira-attachment:77/media:${MEDIA_ID}`,
        },
      ]);
    },
  );

  concurrentTest(
    "records the attachment id before looking up its media UUID",
    async () => {
      const { harness, render } = makeRenderer();
      const clip = artifact("clip.mp4");
      await render("![Clip](artifact:clip.mp4)", [clip]);

      expect(harness.lookupsAtRecord[0]).toBe(0);
      expect(harness.recorded[0]).toMatchObject({
        outcome: "linked",
        externalRef: "jira-attachment:101",
      });
    },
  );

  concurrentTest(
    "looks up the media UUID again for a stored attachment without one, without re-uploading",
    async () => {
      const { harness, render } = makeRenderer();
      const clip = artifact("clip.mp4");

      const rendered = await render(
        "![Clip](artifact:clip.mp4)",
        [clip],
        [
          {
            markerIndex: 0,
            artifactId: clip.artifactId,
            platform: "jira",
            outcome: "linked",
            externalRef: "jira-attachment:77",
          },
        ],
      );

      expect(harness.uploads).toEqual([]);
      expect(harness.reads).toEqual([]);
      expect(harness.lookups).toBeGreaterThan(0);
      const expected = {
        outcome: "embedded",
        externalRef: `jira-attachment:77/media:${MEDIA_ID}`,
      };
      expect(harness.recorded).toMatchObject([expected]);
      expect(rendered.outcomes).toMatchObject([expected]);
    },
  );

  concurrentTest(
    "falls back to a Scarn link when the bytes are gone or Jira refuses the file",
    async () => {
      for (const options of [{ bytes: false }, { uploadStatus: 413 }]) {
        const { render } = makeRenderer(options);
        const clip = artifact("clip.mp4");
        const rendered = await render("![Clip](artifact:clip.mp4)", [clip]);
        expect(rendered.outcomes).toMatchObject([
          { outcome: "linked", externalRef: null },
        ]);
      }
    },
  );

  concurrentTest("rethrows a rejected credential", async () => {
    const { render } = makeRenderer({ uploadStatus: 401 });
    const clip = artifact("clip.mp4");
    let status: number | null = null;
    try {
      await render("![Clip](artifact:clip.mp4)", [clip]);
    } catch (caught) {
      status = (caught as { status: number }).status;
    }
    expect(status).toBe(401);
  });
});

describe("Jira attachment refs", () => {
  concurrentTest("round-trip with and without a media id", () => {
    for (const ref of [
      { attachmentId: "1", mediaId: MEDIA_ID },
      { attachmentId: "2", mediaId: null },
    ]) {
      expect(parseJiraAttachmentRef(formatJiraAttachmentRef(ref))).toEqual(ref);
    }
    expect(parseJiraAttachmentRef(null)).toBeNull();
    expect(parseJiraAttachmentRef("something-else")).toBeNull();
  });
});
