/**
 * AI steps for the `ld-routes-all` pipeline. Like `steps.ts`, the reporter's
 * `category` and `affectedPages` fields steer `classifyIssue`, so they pick
 * which lanes run.
 */
import { defineStep, Repo, Runtime } from "@scarn/sdk/definitions/steps";
import { z } from "zod";
import { description, readOnly, SHOP_CONTEXT } from "./shop";

const ISSUE_CATEGORIES = ["bug", "security", "performance", "ux"] as const;

export const classifyIssue = defineStep({
  key: "classify-issue",
  name: "Classify issue",
  description: "Categorise an issue and list the pages it affects.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Classify this issue: "${input.title}"

- \`category\`: one of ${ISSUE_CATEGORIES.join(", ")}. If \`category\` is set in
  your input, the reporter chose it: return it.
- \`affectedPages\`: the storefront paths a person should look at, such as
  \`/\` or \`/checkout.html\`. If \`affectedPages\` is set in your input, return
  exactly that list; otherwise return an empty list unless the report names a
  page.
- \`summary\`: one sentence restating the issue.
- \`appUrl\`: \`http://localhost:4173\`.
`,
  input: z.object({
    title: z.string(),
    description,
    category: z.string().optional(),
    affectedPages: z.array(z.string()).optional(),
  }),
  result: z.object({
    appUrl: z.string(),
    category: z.enum(ISSUE_CATEGORIES),
    summary: z.string(),
    affectedPages: z.array(z.string()),
  }),
});

export const reproduceBug = defineStep({
  key: "reproduce-bug",
  name: "Reproduce bug",
  description: "Try to reproduce an issue against the running shop.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Reproduce this issue against the running shop at ${input.appUrl}:
${input.summary}

Start the shop, then exercise the API with curl and read the code paths
involved. Record what actually happens in \`observedBehavior\` and the minimal
steps in \`steps\`. If you can't reproduce it, set \`reproduced\` to false and
say what you tried; don't invent a failure.
`,
  input: z.object({ appUrl: z.string(), summary: z.string() }),
  result: z.object({
    reproduced: z.boolean(),
    observedBehavior: z.string(),
    steps: z.array(z.string()),
  }),
});

export const notifySecurity = defineStep({
  key: "notify-security",
  name: "Notify security",
  description: "Write a security advisory for the security team.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
A security issue was reported: ${input.summary}

Write \`notes\` for the security team: what an attacker could do, the code
that exposes it, and the immediate mitigation. Keep it under 150 words.
`,
  input: z.object({ summary: z.string() }),
  result: z.object({ notes: z.string() }),
});

export const writeFailingTest = defineStep({
  key: "write-failing-test",
  name: "Write failing test",
  description: "Encode a reproduced issue as a failing test.",
  status: "active",
  environment: {
    runtime: Runtime.managed.bun1(),
    repo: Repo.readWrite({ message: "test: repro {{workItem.title}}" }),
  },
  agentPrompt: `
${SHOP_CONTEXT}
Write a failing \`bun test\` under \`tests/\` that captures the observed
behavior in your input. If \`securityNotes\` is set, the test must assert on
the security exposure it describes, and its file name should end in
\`.security.test.ts\`.

Run it and confirm it fails for the reported reason, not because of your setup.
Don't fix the bug. Return the test's path and the command that runs only it.
`,
  input: z.object({
    observedBehavior: z.string(),
    securityNotes: z.string().optional(),
  }),
  result: z.object({ testPath: z.string(), testCommand: z.string() }),
});

const pageNotes = z.object({ path: z.string(), notes: z.string() });

export const inspectPage = defineStep({
  key: "inspect-page",
  name: "Inspect page",
  description: "Check one storefront page for the reported issue.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
Start the shop, fetch the page at \`${input.path}\` and the scripts and API calls
it makes, and note anything on it related to the issue under triage. Return the
path unchanged, and your \`notes\` in at most five sentences.
`,
  input: z.object({ path: z.string() }),
  result: pageNotes,
});

export const addToBacklog = defineStep({
  key: "add-to-backlog",
  name: "Add to backlog",
  description: "Write a backlog entry for an issue.",
  status: "active",
  environment: readOnly,
  agentPrompt: `
Write a backlog entry for the issue in your input: a short imperative
\`title\` and a \`priority\`.
`,
  input: z.object({ summary: z.string() }),
  result: z.object({
    title: z.string(),
    priority: z.enum(["low", "medium", "high"]),
  }),
});

export const summariseFindings = defineStep({
  key: "summarise-findings",
  name: "Summarise findings",
  description: "Pull every triage lane's findings into one summary.",
  status: "active",
  environment: readOnly,
  agentPrompt: `
Every triage lane for this issue has finished; their findings are in your
input. Fields from lanes that didn't run are missing or empty. Write one
summary in \`text\` for the person picking this up: the failing test (if any),
what each inspected page showed, and the backlog entry (if any).
`,
  input: z.object({
    failingTest: z.string().optional(),
    pages: z.array(pageNotes),
    backlogTitle: z.string().optional(),
  }),
  result: z.object({ text: z.string() }),
});
