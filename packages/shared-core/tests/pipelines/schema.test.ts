import { describe, expect, test } from "bun:test";
import { pipelineDocumentSchema } from "@scarn/sdk/contracts/pipeline-document";
import { validatePipeline } from "../../src/pipelines";
import { bugPipeline, clone, fullSpecBugPipeline } from "./fixtures";
import { itemsPipeline } from "./fixtures-items";

const minimal = () => ({
  schemaVersion: 1,
  key: "minimal",
  start: { to: "done" },
  nodes: { done: { kind: "succeed" } },
});

describe("pipelineDocumentSchema", () => {
  test.concurrent("accepts the example documents", () => {
    expect(pipelineDocumentSchema.safeParse(bugPipeline()).success).toBe(true);
    expect(pipelineDocumentSchema.safeParse(itemsPipeline()).success).toBe(
      true,
    );
    expect(pipelineDocumentSchema.safeParse(minimal()).success).toBe(true);
  });

  test.concurrent(
    "accepts not-in-v1 features structurally so the validator can explain them",
    () => {
      const document = clone(fullSpecBugPipeline());
      document.nodes["approve-fix"] = {
        kind: "wait",
        for: "timer",
        next: {
          routes: [{ to: "done" }],
        },
      };
      expect(pipelineDocumentSchema.safeParse(document).success).toBe(true);
    },
  );

  test.concurrent("rejects unknown keys anywhere", () => {
    const result = validatePipeline({ ...minimal(), extra: true }, {});
    expect(result.errors).toEqual([
      {
        code: "schema",
        path: "",
        message: 'Unknown key "extra"',
        hint: "Remove it, or check the spelling",
      },
    ]);
    const nested = clone(minimal());
    nested.nodes["done"] = {
      kind: "succeed",
      next: { routes: [{ to: "done" }] },
    };
    expect(validatePipeline(nested, {}).errors[0]?.path).toBe("/nodes/done");
  });

  test.concurrent(
    "rejects bare literals in args with a hint to use { value }",
    () => {
      const document = clone(minimal());
      document["start"] = { to: "done", args: { count: 3 } };
      const [error] = validatePipeline(document, {}).errors;
      expect(error).toMatchObject({
        code: "schema",
        path: "/start/args/count",
        hint: 'Write literals as { "value": ... }',
      });
    },
  );

  test.concurrent("a step's maxTurns is an integer of at least 0", () => {
    const withMaxTurns = (maxTurns: number) => {
      const document = clone(bugPipeline());
      (document.nodes["fix"] as Record<string, unknown>)["maxTurns"] = maxTurns;
      return pipelineDocumentSchema.safeParse(document).success;
    };
    expect(withMaxTurns(0)).toBe(true);
    expect(withMaxTurns(3)).toBe(true);
    expect(withMaxTurns(-1)).toBe(false);
    expect(withMaxTurns(1.5)).toBe(false);
  });

  test.concurrent("rejects maxTurns on a wait node", () => {
    const document = clone(bugPipeline());
    (document.nodes["ask-for-details"] as Record<string, unknown>)["maxTurns"] =
      1;
    expect(pipelineDocumentSchema.safeParse(document).success).toBe(false);
  });

  test.concurrent("rejects an unknown node kind", () => {
    const document = clone(minimal());
    document.nodes["done"] = { kind: "map" };
    expect(validatePipeline(document, {}).errors[0]?.path).toBe(
      "/nodes/done/kind",
    );
  });

  test.concurrent("rejects invalid node ids and workItemFields aliases", () => {
    const document = clone(minimal());
    document.nodes["bad id"] = { kind: "succeed" };
    document["workItemFields"] = { "has space": "Label:" };
    const paths = validatePipeline(document, {}).errors.map(
      (error) => error.path,
    );
    expect(paths).toContain("/nodes/bad id");
    expect(paths).toContain("/workItemFields/has space");
  });
});
