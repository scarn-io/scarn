/**
 * `ld-bundles`'s steps: one bundle of each kind, and a comment linking both.
 *
 * - `writeReport` is a code step that writes an HTML bug report (a page, a
 *   stylesheet, a script with hash routing and an SVG) into its declared
 *   `report` bundle field. The field has `share: true`, so the bundle is
 *   shared by link as soon as it has uploaded.
 * - `buildPrototype` is an AI step. Its agent builds a static prototype and
 *   submits the folder without `field`, as the undeclared bundle `prototype`,
 *   which stays private until someone shares it from the dashboard.
 * - `postBundleLinks` drafts a work item comment that links to both: the
 *   report through its declared field (required), the prototype through a
 *   path marker (optional, dropped if the agent didn't submit it).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Artifact,
  codeStep,
  defineStep,
  Features,
  Notify,
  z,
} from "@scarn/sdk/definitions/steps";
import { description, readOnly, SHOP_CONTEXT } from "./shop";

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const REPORT_CSS = `body {
  font-family: system-ui, sans-serif;
  max-width: 48rem;
  margin: 2rem auto;
  padding: 0 1rem;
  color: #1f2328;
}
nav a {
  margin-right: 1rem;
}
nav a.active {
  font-weight: 600;
}
section[hidden] {
  display: none;
}
img {
  max-width: 100%;
  border: 1px solid #d0d7de;
  border-radius: 6px;
}
`;

const REPORT_JS = `const pages = ["summary", "steps", "evidence"];

function show() {
  const current = location.hash.replace(/^#\\//, "") || "summary";
  for (const page of pages) {
    document.getElementById(page).hidden = page !== current;
    document
      .querySelector('a[href="#/' + page + '"]')
      .classList.toggle("active", page === current);
  }
}

window.addEventListener("hashchange", show);
show();
`;

const REPORT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160" viewBox="0 0 480 160">
  <rect width="480" height="160" fill="#f6f8fa"/>
  <rect x="20" y="40" width="120" height="80" rx="8" fill="#ddf4ff" stroke="#0969da"/>
  <text x="80" y="85" text-anchor="middle" font-family="sans-serif" font-size="14">Report</text>
  <rect x="180" y="40" width="120" height="80" rx="8" fill="#fff8c5" stroke="#9a6700"/>
  <text x="240" y="85" text-anchor="middle" font-family="sans-serif" font-size="14">Expected</text>
  <rect x="340" y="40" width="120" height="80" rx="8" fill="#ffebe9" stroke="#cf222e"/>
  <text x="400" y="85" text-anchor="middle" font-family="sans-serif" font-size="14">Actual</text>
  <path d="M140 80h40M300 80h40" stroke="#57606a" stroke-width="2"/>
</svg>
`;

function reportHtml(title: string, details: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <nav>
      <a href="#/summary">Summary</a>
      <a href="#/steps">Steps</a>
      <a href="#/evidence">Evidence</a>
    </nav>
    <section id="summary">
      <p>${escapeHtml(details)}</p>
    </section>
    <section id="steps" hidden>
      <ol>
        <li>Start the shop with <code>PORT=4173 bun server.mjs</code>.</li>
        <li>Follow the report above.</li>
        <li>Compare what happens with what the reporter expected.</li>
      </ol>
    </section>
    <section id="evidence" hidden>
      <img src="media/flow.svg" alt="Report, expected and actual behaviour" />
    </section>
    <script src="app.js"></script>
  </body>
</html>
`;
}

export const writeReport = codeStep({
  key: "write-report",
  name: "Write the bug report",
  inputSchema: z.object({ title: z.string(), description }),
  resultSchema: z.object({
    report: z.artifact
      .bundle({ share: true })
      .describe("HTML bug report, shared by link"),
  }),
  fn: async ({ title, description }, { artifactsDir }) => {
    const root = join(artifactsDir, "report");
    await mkdir(join(root, "media"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, "index.html"),
        reportHtml(title, description ?? "No description was given."),
      ),
      writeFile(join(root, "styles.css"), REPORT_CSS),
      writeFile(join(root, "app.js"), REPORT_JS),
      writeFile(join(root, "media", "flow.svg"), REPORT_SVG),
    ]);
    return { report: Artifact.path("report") };
  },
});

export const buildPrototype = defineStep({
  key: "build-prototype",
  name: "Build a prototype",
  description: "Build a static prototype of a fix and submit it as a bundle.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
A report came in: "${input.title}"

Build a small clickable prototype of how the fixed page could look, as plain
static files in \`out/prototype/\`: \`index.html\`, \`styles.css\` and
\`app.js\`. Base it on the shop's real markup in \`public/\`. No build step.

It is opened from a share link, so:
- use relative paths only (\`src="app.js"\`, never \`/app.js\`);
- load nothing from other sites: no CDN scripts, fonts or API calls;
- give it two views with hash routing (\`#/\` and \`#/fixed\`);
- keep state in memory; \`localStorage\` and cookies throw.

Submit the folder with scarn-submit-artifact using path "out/prototype" and
name "prototype". Don't pass \`field\`. Then describe the prototype in one or
two sentences as \`summary\`.
`,
  input: z.object({ title: z.string(), description }),
  result: z.object({ summary: z.string() }),
});

export const postBundleLinks = codeStep({
  key: "post-bundle-links",
  name: "Post the bundle links",
  features: [Features.notifications()],
  inputSchema: z.object({ title: z.string(), summary: z.string() }),
  fn: ({ title, summary }) =>
    Notify.create({
      kind: "result_ready",
      title: `Bundles ready: ${title}`,
      body: [
        `The bug report and a prototype are ready. ${summary}`,
        Artifact.link(
          { step: writeReport, path: "report" },
          { label: "Bug report" },
        ),
        Artifact.link("prototype/", { label: "Prototype" }),
      ].join("\n\n"),
      priority: "normal",
      suggestedChannels: ["in_app", "work_item_platform_comment"],
    }),
});
