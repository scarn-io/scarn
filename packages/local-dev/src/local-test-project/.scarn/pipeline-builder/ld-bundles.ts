/**
 * Artifact bundles: `write-report` fills its declared `report` bundle field
 * (`share: true`, so it is shared by link once uploaded), `build-prototype`'s
 * agent submits an undeclared `prototype` bundle that stays private, and
 * `post-bundle-links` drafts a comment linking to both.
 */
import { definePipeline, succeed, workItem } from "@scarn/sdk/pipelines";
import { buildPrototype, postBundleLinks, writeReport } from "./bundles-steps";

const done = succeed("done");

export default definePipeline({
  key: "ld-bundles",
  title: "Local dev: shareable artifact bundles",
  start: writeReport({
    title: workItem.title,
    description: workItem.description,
  }),
  flow: [
    writeReport.settings({ title: "Write the bug report" }).next((r) =>
      buildPrototype({
        title: r.input.title,
        description: r.input.description,
      }),
    ),
    buildPrototype
      .settings({ title: "Build a prototype" })
      .next((r) =>
        postBundleLinks({ title: r.input.title, summary: r.result.summary }),
      ),
    postBundleLinks.settings({ title: "Post the bundle links" }).next(done),
  ],
});
