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
    "Turns a fuzzy goal into a plan by spawning research, prototype and grilling tickets until the way is clear.",
  descriptionMarkdown: `\
Wayfinder takes a goal that isn't clear enough to build yet and finds the way.

The **plan** step keeps a map on its work item: the goal, notes, decisions so far, the open questions ("fog") and, once the fog clears, the plan. Each round it creates child tickets for the open questions, starts a Task on each, blocks its own item on them and waits. When every ticket is closed it reads their resolutions, updates the map and starts the next round, until nothing is left open.

### Hand-off steps

The pipeline graph is just \`plan\`. The planner starts these steps on its child tickets itself, by key:

- **research** answers one factual question with evidence from the code, its docs or the web. Read-only.
- **prototype** builds a throwaway spike on its own work branch to find out whether an approach works.
- **grilling** asks a person, round by round, to settle a decision only they can make.

### When to use it

Use Wayfinder for work that needs investigating and deciding before anyone can build it. Assign it with \`assign("wayfinder")\` in \`default-pipeline-assignment.ts\`.
`,
  tags: ["planning", "agents"],
  pipelineKey: "wayfinder",
  stepKeys: ["plan", "research", "prototype", "grilling"],
  handoffSteps: [
    {
      key: "research",
      startedBy: "plan",
      summary: "Answers one question on the map with evidence.",
    },
    {
      key: "prototype",
      startedBy: "plan",
      summary:
        "Builds a throwaway spike to find out whether an approach works.",
    },
    {
      key: "grilling",
      startedBy: "plan",
      summary: "Settles a decision with a person, round by round.",
    },
  ],
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
  pipelineKey: "web-repro-playwright",
  stepKeys: ["web-repro-playwright"],
  handoffSteps: [],
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
