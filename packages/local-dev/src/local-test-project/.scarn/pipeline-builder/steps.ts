/**
 * Steps for the `ld-*` pipelines, against the `acme-shop` checkout. Steps
 * that reason or write are AI steps on the managed `bun1` runtime. A
 * work-item field that picks a branch (`severity`, `requiresApproval`,
 * `detail`, `files`/`failFiles`) reaches the step as a hint its prompt tells
 * the agent to honor, so a seeded item usually, not provably, takes its branch.
 *
 * Steps that exercise engine mechanics (a guaranteed throw, a timeout, a loop
 * counter, pure aggregation) stay code steps. Their inputs arrive as raw JSON,
 * so optional fields are defaulted inside `fn`. `answer` is `unknown` because
 * the validator won't pass the reply's `string | null` body into a zod
 * `string | null` (`anyOf`) input.
 */
import {
  codeStep,
  defineStep,
  Repo,
  Runtime,
} from "@scarn/sdk/definitions/steps";
import { z } from "zod";
import { description, readOnly, SHOP_CONTEXT } from "./shop";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const report = z.object({
  title: z.string(),
  summary: z.string(),
  area: z.string(),
});
const analysis = z.object({
  title: z.string(),
  severity: z.enum(["minor", "major"]),
  rationale: z.string(),
});

export const intake = defineStep({
  key: "intake",
  name: "Intake",
  description: "Read an incoming report and restate it against the codebase.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
A report just came in: "${input.title}"

Restate it in one or two plain sentences as \`summary\`, and name the part of
the shop it most likely touches (a file, page or API route) as \`area\`. Look at
the code to pick the area; don't guess from the title alone. Return the title
unchanged.
`,
  input: z.object({ title: z.string(), description }),
  result: report,
});

export const analyze = defineStep({
  key: "analyze",
  name: "Analyze",
  description: "Judge how severe a report is.",
  status: "active",
  environment: readOnly,
  agentPrompt: `
${SHOP_CONTEXT}
Your input holds a report with the area of the shop it touches. Read that code
and judge the severity: \`major\` if it breaks buying, loses money or data, or
affects every visitor; \`minor\` otherwise. Explain the call in \`rationale\`
in at most three sentences, naming the code you looked at.
`,
  input: z.object({ report }),
  result: analysis,
});

export const summarize = defineStep({
  key: "summarize",
  name: "Summarize",
  description: "Write a short summary for the work item.",
  status: "active",
  environment: readOnly,
  agentPrompt: `
Write a short summary (at most four sentences) of the analysed report in your
input, for someone skimming the backlog: what is wrong, how bad it is and
where in the code it lives.
`,
  input: z.object({ analysis }),
  result: z.object({ text: z.string() }),
});

const SEVERITIES = ["critical", "minor", "invalid"] as const;

export const classify = defineStep({
  key: "classify",
  name: "Classify",
  description: "Classify a report as critical, minor or invalid.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Classify this report: "${input.title}"

- \`critical\`: customers cannot buy, or money is wrong, right now.
- \`minor\`: a real problem that can wait for a ticket.
- \`invalid\`: not a real problem, or the report can't be acted on.

The reporter's severity, if any, is in \`severity\` in your input. Treat it as
authoritative: when it is one of the values above, return it. Otherwise judge
for yourself. Say in \`rationale\` whether you agree with the reporter.
`,
  input: z.object({
    title: z.string(),
    description,
    severity: z.string().optional(),
  }),
  result: z.object({
    severity: z.enum(SEVERITIES),
    rationale: z.string(),
  }),
});

export const pageOncall = defineStep({
  key: "page-oncall",
  name: "Page on-call",
  description: "Write the page sent to the on-call engineer.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
A ${input.severity} incident was reported: "${input.title}"

Write the page for the on-call engineer: one line saying what is broken, then
the code most likely at fault and the first thing to check. Keep it under 80
words; it is read on a phone.
`,
  input: z.object({
    title: z.string(),
    severity: z.string(),
    rationale: z.string(),
  }),
  result: z.object({ page: z.string() }),
});

export const fileTicket = defineStep({
  key: "file-ticket",
  name: "File a ticket",
  description: "Write a backlog ticket for a non-urgent report.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Write a ticket for this ${input.severity} report: "${input.title}"

Give it a clear title, a body with what is wrong, where in the code and what
done looks like, and one to three labels.
`,
  input: z.object({
    title: z.string(),
    severity: z.string(),
    rationale: z.string(),
  }),
  result: z.object({
    title: z.string(),
    body: z.string(),
    labels: z.array(z.string()),
  }),
});

const fixPlan = z.object({
  requiresHumanApproval: z.boolean(),
  summary: z.string(),
  steps: z.array(z.string()),
});

export const proposeFix = defineStep({
  key: "propose-fix",
  name: "Propose a fix",
  description: "Plan a fix for a bug report.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Plan a fix for: "${input.title}"

Find the code at fault and write a plan: a one-paragraph \`summary\` and the
concrete edits as \`steps\`. Don't change any files.

If \`feedback\` in your input is set, a reviewer asked for changes to your last
plan: revise the plan to address it, and say how in the summary.

Set \`requiresHumanApproval\` to \`requiresApproval\` from your input when it is
given. When it isn't, set it to true unless the fix is trivial and low-risk.
`,
  input: z.object({
    title: z.string(),
    description,
    requiresApproval: z.boolean().optional(),
    feedback: z.string().nullable().optional(),
  }),
  result: fixPlan,
});

export const applyFix = defineStep({
  key: "apply-fix",
  name: "Apply the fix",
  description: "Carry out an approved fix plan.",
  status: "active",
  environment: {
    runtime: Runtime.managed.bun1(),
    repo: Repo.readWrite({ message: "fix: {{workItem.title}}" }),
  },
  agentPrompt: `
${SHOP_CONTEXT}
Carry out the fix plan in your input. Make only the edits the plan describes.
Start the shop and check the fix by hand (curl the API or fetch the page). List
every file you changed in \`filesChanged\` and say what you verified in
\`applied\`.
`,
  input: z.object({ plan: fixPlan }),
  result: z.object({
    applied: z.string(),
    filesChanged: z.array(z.string()),
  }),
});

export const evaluate = defineStep({
  key: "evaluate",
  name: "Evaluate detail",
  description: "Decide whether a report has enough detail to act on.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Decide whether this report has enough detail to act on: "${input.title}"

It has enough detail when you can tell which page or API route is involved and
what the reporter expected instead. If \`answer\` in your input is set, it is
the reporter's reply to your earlier questions; count it as part of the report.

The reporter's \`detail\` field, if any, is a hint: \`full\` means they say they
gave everything, \`thin\` means they know it is vague. Unless \`answer\`
supplies what was missing, follow the hint.

Set \`complete\`. When it is false, list each missing detail as one short
question in \`questions\`; otherwise return an empty list.
`,
  input: z.object({
    title: z.string(),
    description,
    detail: z.string().optional(),
    answer: z.unknown().optional(),
  }),
  result: z.object({
    complete: z.boolean(),
    questions: z.array(z.string()),
  }),
});

export const triage = defineStep({
  key: "triage",
  name: "Triage",
  description: "Triage a report that has enough detail.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Triage this report: "${input.title}"

Use the report and, if set, the reporter's \`answer\` in your input. Find the
code involved and write \`notes\`: the likely cause, where it lives, and the
next step for whoever picks it up.
`,
  input: z.object({
    title: z.string(),
    description,
    detail: z.string().optional(),
    answer: z.unknown().optional(),
  }),
  result: z.object({ notes: z.string() }),
});

const attemptResult = z.object({ attempt: z.number(), passed: z.boolean() });

export const attempt = codeStep({
  key: "attempt",
  name: "Attempt",
  inputSchema: z.object({
    passOnAttempt: z.number().optional(),
    previous: attemptResult.optional(),
  }),
  resultSchema: attemptResult,
  fn: ({ passOnAttempt, previous }) => {
    const current = (previous?.attempt ?? 0) + 1;
    return { attempt: current, passed: current >= (passOnAttempt ?? 3) };
  },
});

const FLAKY_SLEEP_SECONDS = 300;

export const flaky = codeStep({
  key: "flaky",
  name: "Flaky",
  inputSchema: z.object({
    failMode: z.enum(["throw", "sleep", "none"]).optional(),
  }),
  resultSchema: z.object({ mode: z.string() }),
  fn: async ({ failMode }) => {
    const mode = failMode ?? "none";
    if (mode === "throw") {
      throw new Error("flaky: failMode is throw, so every attempt fails");
    }
    if (mode === "sleep") {
      await sleep(FLAKY_SLEEP_SECONDS * 1000);
    }
    return { mode };
  },
});

export const recover = codeStep({
  key: "recover",
  name: "Recover",
  inputSchema: z.object({ errorName: z.string(), message: z.string() }),
  resultSchema: z.object({ recovered: z.string() }),
  fn: ({ errorName, message }) => ({
    recovered: `recovered from ${errorName}: ${message}`,
  }),
});

const lane = z.object({ path: z.string(), shouldFail: z.boolean() });
const edit = z.object({ path: z.string(), diff: z.string() });

export const planFiles = defineStep({
  key: "plan-files",
  name: "Plan files",
  description: "Split a refactor into one lane per file.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Plan this change: "${input.title}"

Find the files it touches and return one lane per file, with its repo-relative
\`path\`, plus a one-line \`summary\` of the whole change.

This pipeline is a test harness, so two fields in your input override your
judgment:
- \`files\` (default 3): return exactly that many lanes. Pad with the next most
  relevant files, or drop the least relevant ones.
- \`failFiles\` (default 0): set \`shouldFail\` to true on the first that many
  lanes and false on the rest.
`,
  input: z.object({
    title: z.string(),
    description,
    files: z.number().optional(),
    failFiles: z.number().optional(),
  }),
  result: z.object({ lanes: z.array(lane), summary: z.string() }),
});

export const editFile = codeStep({
  key: "edit-file",
  name: "Edit a file",
  inputSchema: lane,
  resultSchema: edit,
  fn: ({ path, shouldFail }) => {
    if (shouldFail) {
      throw new Error(`edit-file: ${path} is in failFiles`);
    }
    return { path, diff: `+ // edited ${path}` };
  },
});

export const collectEdits = codeStep({
  key: "collect-edits",
  name: "Collect edits",
  inputSchema: z.object({ edits: z.array(edit) }),
  resultSchema: z.object({ edits: z.array(edit), count: z.number() }),
  fn: ({ edits }) => ({ edits, count: edits.length }),
});

export const openPr = defineStep({
  key: "open-pr",
  name: "Open a pull request",
  description: "Write the pull request for a set of approved edits.",
  status: "active",
  environment: readOnly,
  agentPrompt: `
Write the pull request for the approved edits in your input: a conventional
title under 70 characters, and a body that states the change from \`summary\`,
lists each edited file with a one-line note, and says how to verify it.
`,
  input: z.object({ summary: z.string(), edits: z.array(edit) }),
  result: z.object({ title: z.string(), body: z.string() }),
});

export const grillStopped = codeStep({
  key: "grill-stopped",
  name: "Grill stopped",
  inputSchema: z.object({ topic: z.string(), reason: z.string() }),
  resultSchema: z.object({ summary: z.string() }),
  fn: ({ topic, reason }) => ({
    summary: `Grilling on "${topic}" stopped at the turn limit (${reason}). See the step's conversation for what was settled.`,
  }),
});
