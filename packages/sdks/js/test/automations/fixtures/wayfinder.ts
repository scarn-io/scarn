import { z } from "zod";
import { codeStep, defineStep } from "@scarn/sdk/definitions/steps";
import { contains, definePipeline, succeed } from "@scarn/sdk/pipelines";
import {
  attach,
  defineAutomation,
  onEvent,
  skip,
} from "@scarn/sdk/automations";

export const plan = defineStep({
  key: "plan",
  name: "Plan",
  agentPrompt: "Plan the map.",
});

export const research = codeStep({
  key: "research",
  name: "Research",
  inputSchema: z.object({ question: z.string() }),
  fn: () => ({}),
});

export const triage = definePipeline({
  key: "triage",
  start: plan(),
  flow: [plan.next(succeed("done"))],
});

export const wayfinder = defineAutomation({
  key: "wayfinder",
  title: "Wayfinder",
  scope: "workItem",
  rules: [
    onEvent({ event: "self.attached", to: (r) => plan().on(r.workItem) }),
    onEvent({
      event: "child.ready",
      routes: [
        {
          when: (r) => contains(r.child.labels, "wayfinder:research"),
          to: (r) => research({ question: r.child.title }).on(r.child),
        },
      ],
      otherwise: skip,
    }),
    onEvent({ event: "child.closed", to: (r) => plan().on(r.workItem) }),
  ],
});

export const projectDefault = defineAutomation({
  key: "default",
  scope: "project",
  rules: [
    onEvent({
      event: "workItem.label.added",
      match: "all",
      routes: [
        {
          when: (r) => contains(r.label, "wayfinder"),
          to: attach(wayfinder),
        },
        { when: (r) => contains(r.workItem.labels, "bug"), to: triage },
      ],
    }),
    onEvent({ event: "workItem.created", to: (r) => triage.on(r.workItem) }),
    onEvent({ event: "workItem.ready", to: plan }),
  ],
});
