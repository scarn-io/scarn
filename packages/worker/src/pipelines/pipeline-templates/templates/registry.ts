/**
 * Every pipeline template the CLI ships. The `.ts.tmpl` sources are inlined
 * at build time, so the compiled CLI carries them as strings.
 */
import type { PipelineTemplate } from "../domain/pipeline-template";
import webReproPlaywrightSource from "./web-repro-playwright.ts.tmpl" with { type: "text" };
import wayfinderSource from "./wayfinder.ts.tmpl" with { type: "text" };

const wayfinder: PipelineTemplate = {
  key: "wayfinder",
  name: "Wayfinder",
  summary:
    "Turns a fuzzy goal into a plan by charting child work items for research, prototypes and decisions until the way is clear.",
  descriptionMarkdown: `\
Wayfinder takes a goal that isn't clear enough to build yet and finds the way. It's a work-item automation with four steps.

The **plan** step keeps a map in its work item's description: the goal, notes, decisions so far, what's not yet specified and, once nothing is, the plan. It charts the map by creating child work items, each asking one question, with one label and the blockers it needs answered first.

### Labels

When a child work item becomes ready (open, nothing open blocking it), the automation starts the step its label names:

- \`wayfinder:research\` → **research** answers one factual question with evidence from the code, its docs or the web. Read-only.
- \`wayfinder:prototype\` → **prototype** builds a throwaway spike on its own work branch to find out whether an approach works.
- \`wayfinder:grilling\` → **grilling** asks a person, round by round, to settle a decision only they can make.
- \`wayfinder:task\` starts nothing. It's work only a person can do before a decision can be made, such as signing up for a service, provisioning access or moving data. Its description says why, lists the steps and says what to record when you close it. Do it by hand, then close it with those facts in the resolution.

### A fresh round per close

Every time a child work item closes, the automation starts a fresh **plan** Task that reads the map live. It folds every closed child into the decisions, then charts new children, waits, or writes the plan and closes the map. At most one round runs and one waits; more closes while one waits are folded into that round. Closing the map stops the automation.

### Attaching it

Attach Wayfinder to a work item from the work item page, or with \`scarn automations attach <workItem> wayfinder\`. To attach it from a project automation, add a route in \`default.ts\`, e.g. \`{ when: (r) => contains(r.label, "wayfinder"), to: attach(wayfinder) }\` on \`workItem.label.added\`.
`,
  tags: ["planning", "agents"],
  entry: { kind: "automation", key: "wayfinder" },
  stepKeys: ["plan", "research", "prototype", "grilling"],
  parameters: [
    {
      key: "planning_guidance",
      label: "Planning Guidance",
      description:
        "Optional guidance for the planner, such as constraints, conventions or what a finished plan should contain.",
      type: "textarea",
      required: false,
      placeholder:
        "Prefer small, reversible steps. A finished plan lists the tickets to build, in order.",
    },
  ],
  source: wayfinderSource,
};

const webReproPlaywright: PipelineTemplate = {
  key: "web-repro-playwright",
  name: "Web Repro Playwright",
  summary:
    "Reproduces a reported browser issue with Playwright and summarizes the evidence.",
  descriptionMarkdown: `\
A one-step pipeline that reproduces a reported browser bug.

The **web-repro-playwright** step runs in the repository's devcontainer, starts the app if it isn't running, and drives it with the Playwright MCP server in headless Chromium. It records a Playwright trace of the repro, waits after the final action to catch delayed failures, and returns an outcome (\`reproduced\`, \`not_reproducible\`, \`needs_user_feedback\`, …) with the steps it tried and what it saw.

When it lacks something only your team knows, such as credentials or a purchasing flow, it stops with \`needs_user_feedback\` and asks instead of guessing.

### Setup

Tell it how to reach your application in **Application Access Instructions**: the URL, test credentials and any environment details.
`,
  tags: ["bugs", "browser"],
  entry: { kind: "pipeline", key: "web-repro-playwright" },
  stepKeys: ["web-repro-playwright"],
  parameters: [
    {
      key: "app_access_instructions",
      label: "Application Access Instructions",
      description:
        "Describe how the agent should access your application — URL, login credentials, environment details, etc.",
      type: "textarea",
      required: true,
      placeholder:
        "Navigate to https://app.example.com and log in with test@example.com / password123.",
    },
    {
      key: "additional_instructions",
      label: "Additional Instructions",
      description:
        "Optional extra guidance for the agent, such as specific flows to test or areas to focus on.",
      type: "textarea",
      required: false,
      placeholder:
        "Focus on the checkout flow and test with a cart containing 3+ items.",
    },
  ],
  source: webReproPlaywrightSource,
};

export const PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  wayfinder,
  webReproPlaywright,
];
