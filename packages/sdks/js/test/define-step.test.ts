import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineStep } from "../src/definitions/steps/define-step";
import {
  Features,
  type AnyStepFeature,
} from "../src/definitions/steps/step-features";

describe("defineStep", () => {
  test("applies sensible defaults", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
    });
    expect(spec).toMatchObject({
      version: 1,
      kind: "user_defined",
      status: "active",
      description: null,
      prompt: "Do the work.",
      inputSchemaJson: null,
      resultSchemaJson: null,
      opencodeMcpJson: null,
    });
  });

  test("supports function agent prompts with scoped prompt tokens", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      input: z.object({ title: z.string() }),
      agentPrompt: ({ input, env, scarn }) =>
        `Open ${env.BASE_URL ?? ""} for ${input.title} and save artifacts to ${scarn.artifactsDir}`,
    });

    expect(spec.prompt).toBe(
      "Open {{env.BASE_URL}} for {{input.title}} and save artifacts to {{scarn.artifactsDir}}",
    );
  });

  test("converts a complex nested result schema to JSON Schema", () => {
    const resultSchema = z
      .object({
        outcome: z.enum([
          "reproduced",
          "not_reproducible",
          "needs_user_feedback",
          "agent_error",
          "cancelled",
        ]),
        summaryOfFindings: z.string().min(1),
        stepsTried: z.array(z.string().min(1)),
        observedBehavior: z.string().nullable().optional(),
        expectedBehavior: z.string().nullable().optional(),
        failureReason: z.string().nullable().optional(),
        rawResultJson: z.record(z.string(), z.unknown()).nullable().optional(),
        itemsV1: z
          .array(
            z.object({
              question: z.string(),
              category: z.string(),
            }),
          )
          .optional(),
      })
      .loose();

    const spec = defineStep({
      key: "debug-issue",
      name: "Debug Issue",
      agentPrompt: "Analyze the issue.",
      result: resultSchema,
    });

    expect(spec.resultSchemaJson).toMatchObject({
      type: "object",

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      required: expect.arrayContaining([
        "outcome",
        "summaryOfFindings",
        "stepsTried",
      ]),
      properties: {
        outcome: {
          type: "string",
          enum: [
            "reproduced",
            "not_reproducible",
            "needs_user_feedback",
            "agent_error",
            "cancelled",
          ],
        },
        summaryOfFindings: { type: "string", minLength: 1 },
        stepsTried: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        itemsV1: {
          type: "array",
          items: {
            type: "object",

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            required: expect.arrayContaining(["question", "category"]),
            properties: {
              question: { type: "string" },
              category: { type: "string" },
            },
          },
        },
      },
    });
  });

  describe("features", () => {
    const mockFeatureA: AnyStepFeature = {
      _resultExtension: z.object({ flagA: z.boolean() }),
      _promptAddition: "Feature A instructions",
    };
    const mockFeatureB: AnyStepFeature = {
      _resultExtension: z.object({ labelB: z.string() }),
      _promptAddition: "Feature B instructions",
    };

    test("merges feature result extension into resultSchemaJson", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        result: z.object({ score: z.number() }),
        features: [mockFeatureA],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          score: { type: "number" },
          flagA: { type: "boolean" },
        },
      });
    });

    test("builds resultSchemaJson from feature alone when no base result schema", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        features: [mockFeatureA],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: { flagA: { type: "boolean" } },
      });
    });

    test("appends feature prompt addition to the base agent prompt", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        features: [mockFeatureA],
      });

      expect(spec.prompt).toBe("Do the work.\n\nFeature A instructions");
    });

    test("appends feature prompt addition to existing prompt with double newline separator", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Base prompt.",
        features: [mockFeatureA],
      });

      expect(spec.prompt).toBe("Base prompt.\n\nFeature A instructions");
    });

    test("appends feature prompt additions after function prompt normalization", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        input: z.object({ title: z.string() }),
        agentPrompt: ({ input }) => `Use ${input.title}.`,
        features: [mockFeatureA],
      });

      expect(spec.prompt).toBe(
        "Use {{input.title}}.\n\nFeature A instructions",
      );
    });

    test("multiple features merge all result extensions and prompts", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        features: [mockFeatureA, mockFeatureB],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          flagA: { type: "boolean" },
          labelB: { type: "string" },
        },
      });
      expect(spec.prompt).toBe(
        "Do the work.\n\nFeature A instructions\n\nFeature B instructions",
      );
    });

    test("Features.notifications() injects notifications field and prompt section", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        result: z.object({ outcome: z.string() }),
        agentPrompt: "Do the thing.",
        features: [Features.notifications()],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          outcome: { type: "string" },
          $scarn_notifications_v1: { type: "array" },
        },
      });
      expect(spec.prompt).toContain("## User Notifications");
      expect(spec.prompt).toMatch(/^Do the thing\.\n\n/);
    });

    test("Features.feedbackRequests() writes the same notifications field, narrowed to kind: 'feedback_request'", () => {
      const spec = defineStep({
        key: "my-step",
        name: "My Step",
        result: z.object({ outcome: z.string() }),
        agentPrompt: "Do the thing.",
        features: [Features.feedbackRequests()],
      });

      expect(spec.resultSchemaJson).toMatchObject({
        properties: {
          $scarn_notifications_v1: {
            type: "array",
            items: { properties: { kind: { const: "feedback_request" } } },
          },
        },
      });
    });
  });

  describe("work item features", () => {
    test("collects each feature's grant onto the spec", () => {
      const spec = defineStep({
        key: "plan",
        name: "Plan",
        agentPrompt: "Plan it.",
        features: [
          Features.workItems.read({ scope: "children" }),
          Features.workItems.label({ scope: "self", labels: ["ready"] }),
          Features.workItems.create({
            scope: "children",
            labels: ["afk", "hitl"],
          }),
        ],
      });
      expect(spec.grants).toEqual([
        { resource: "workItem", action: "read", scope: "children" },
        {
          resource: "workItem",
          action: "label",
          scope: "self",
          labels: ["ready"],
        },
        {
          resource: "workItem",
          action: "create",
          scope: "children",
          labels: ["afk", "hitl"],
        },
      ]);
      expect(spec.resultSchemaJson).toBeNull();
    });

    test("keeps label literals in the grant type", () => {
      const feature = Features.workItems.create({
        scope: "children",
        labels: ["afk", "hitl"],
      });
      const labels: ["afk", "hitl"] = feature._grant.labels;
      expect(labels).toEqual(["afk", "hitl"]);
    });

    test("adds a prompt section naming the tool, and the labels for label and create", () => {
      const spec = defineStep({
        key: "plan",
        name: "Plan",
        agentPrompt: "Plan it.",
        features: [
          Features.workItems.comment({ scope: "self" }),
          Features.workItems.create({ scope: "children", labels: ["afk"] }),
        ],
      });
      expect(spec.prompt).toStartWith(
        "Plan it.\n\n## Work Items: Comment on Your Work Item",
      );
      expect(spec.prompt).toContain("`scarn-comment-on-work-item`");
      expect(spec.prompt).toContain("## Work Items: Create Child Work Items");
      expect(spec.prompt).toContain("`scarn-create-work-item`");
      expect(spec.prompt).toContain("- `afk`");
      expect(spec.prompt).toContain("Any other label is rejected.");
    });

    test.each([
      ["read", "scarn-get-work-item"],
      ["update", "scarn-set-work-item-description"],
      ["block", "scarn-block-work-item"],
      ["close", "scarn-close-work-item"],
    ] as const)("%s names %s", (action, tool) => {
      expect(
        Features.workItems[action]({ scope: "self" })._promptAddition,
      ).toContain(`\`${tool}\``);
    });

    test("label names scarn-label-work-item and its labels", () => {
      const prompt = Features.workItems.label({
        scope: "children",
        labels: ["bug"],
      })._promptAddition;
      expect(prompt).toContain("`scarn-label-work-item`");
      expect(prompt).toContain("child work items");
      expect(prompt).toContain("- `bug`");
    });

    test("throws when two features grant the same action and scope", () => {
      expect(() =>
        defineStep({
          key: "plan",
          name: "Plan",
          agentPrompt: "Plan it.",
          features: [
            Features.workItems.label({ scope: "self", labels: ["a"] }),
            Features.workItems.label({ scope: "self", labels: ["b"] }),
          ],
        }),
      ).toThrow('Step "plan": more than one Features.workItems.label');
    });

    test("allows the same action on different scopes", () => {
      const spec = defineStep({
        key: "plan",
        name: "Plan",
        agentPrompt: "Plan it.",
        features: [
          Features.workItems.close({ scope: "self" }),
          Features.workItems.close({ scope: "children" }),
        ],
      });
      expect(spec.grants).toHaveLength(2);
    });

    test("rejects invalid work item features at the type level", () => {
      const typeOnly = () => [
        // @ts-expect-error create only covers children
        Features.workItems.create({ scope: "self", labels: ["afk"] }),
        // @ts-expect-error label needs labels
        Features.workItems.label({ scope: "self" }),
        // @ts-expect-error label needs at least one label
        Features.workItems.label({ scope: "self", labels: [] }),
      ];
      expect(typeof typeOnly).toBe("function");
    });
  });
});
