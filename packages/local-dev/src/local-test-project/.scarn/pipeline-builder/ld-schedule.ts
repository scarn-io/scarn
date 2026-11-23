/**
 * Schedules: the `ld-schedule` project automation's `sweep-coupons` rule
 * starts `sweep-coupons` every 5 minutes as a scheduled Task, with no work
 * item. The agent reads the shop's coupon codes and
 * creates one top-level work item per code through its `create` grant on
 * `project`, keyed `coupon:<CODE>`. The `default` automation then routes each
 * new item (`demo: "schedule"`) to `ld-linear`. A second run finds the same
 * keys and creates nothing.
 */
import { defineAutomation, onEvent } from "@scarn/sdk/automations";
import { defineStep, Features } from "@scarn/sdk/definitions/steps";
import { z } from "zod";
import { readOnly, SHOP_CONTEXT } from "./shop";

export const sweepCoupons = defineStep({
  key: "sweep-coupons",
  name: "Sweep coupon codes",
  description:
    "Create a work item asking for a test of each coupon code the shop accepts.",
  status: "active",
  environment: readOnly,
  agentPrompt: ({ input }) => `
${SHOP_CONTEXT}
You run on a schedule, for ${input.until}. The last successful run was for
${input.since} (empty means this is the first run).

Find every coupon code the shop accepts: read the coupon handling in the code,
not just the README. For each code, create a work item with:

- platformKey: \`coupon:<CODE>\`, for example \`coupon:SAVE10\`
- title: \`Add a test for coupon <CODE>\`
- description: what the code does, naming the code that applies it
- fields: \`{ "demo": "schedule", "coupon": "<CODE>" }\`
- labels: \`["coupons"]\`

A code that already has a work item comes back unchanged; that is expected.
Return the codes you found.
`,
  input: z.object({ since: z.string().nullable(), until: z.string() }),
  result: z.object({ codes: z.array(z.string()) }),
  features: [
    Features.workItems.create({ scope: "project", labels: ["coupons"] }),
  ],
});

export default defineAutomation({
  key: "ld-schedule",
  title: "Local dev: coupon sweep every 5 minutes",
  scope: "project",
  rules: [
    onEvent({
      key: "sweep-coupons",
      event: "schedule",
      cron: "*/5 * * * *",
      to: (r) =>
        sweepCoupons({
          since: r.schedule.previousScheduledFor,
          until: r.schedule.scheduledFor,
        }),
    }),
  ],
});
