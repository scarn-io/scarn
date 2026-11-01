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
});
