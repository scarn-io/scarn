import { describe, expect, test } from "bun:test";
import {
  formatReference,
  parseReference,
  readPath,
  ReferenceError,
  resolveArgs,
  resolveReferenceString,
  type ReferenceContext,
} from "../../src/pipelines";

describe("parseReference", () => {
  test.concurrent("parses every reference kind", () => {
    const cases = {
      result: { kind: "result", path: [] },
      "result.files.0": { kind: "result", path: ["files", "0"] },
      "input.plan": { kind: "input", path: ["plan"] },
      item: { kind: "item", path: [] },
      "item.name": { kind: "item", path: ["name"] },
      error: { kind: "error", path: [] },
      "error.name": { kind: "error", path: ["name"] },
      "error.message": { kind: "error", path: ["message"] },
      "nodes.evaluate.result": {
        kind: "node",
        nodeId: "evaluate",
        source: "result",
        path: [],
      },
      "nodes.failing-test.input.investigation": {
        kind: "node",
        nodeId: "failing-test",
        source: "input",
        path: ["investigation"],
      },
      "nodes.result.result.x": {
        kind: "node",
        nodeId: "result",
        source: "result",
        path: ["x"],
      },
      "workItem.title": { kind: "workItemTitle" },
      "workItem.description": { kind: "workItemDescription" },
      "workItem.fields.companyNames": {
        kind: "workItemField",
        alias: "companyNames",
        path: [],
      },
    };
    for (const [text, reference] of Object.entries(cases)) {
      const parsed = parseReference(text);
      expect(parsed).toEqual({ ok: true, reference } as never);
      if (parsed.ok) {
        expect(formatReference(parsed.reference)).toBe(text);
      }
    }
  });

  test.concurrent("rejects literals written as strings with a hint", () => {
    const parsed = parseReference("reproduced");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('{ "value": ... }');
      expect(parsed.hint).toContain('{ "value": "reproduced" }');
    }
  });

  test.concurrent("rejects malformed references", () => {
    for (const text of [
      "",
      " result",
      "result..x",
      "result.",
      "nodes.x",
      "nodes.x.output",
      "nodes",
      "error.stack",
      "error.name.x",
      "workItem",
      "workItem.body",
      "workItem.title.x",
      "workItem.description.x",
      "workItem.fields",
    ]) {
      expect(parseReference(text).ok).toBe(false);
    }
  });
});

describe("resolveReferenceString", () => {
  const context: ReferenceContext = {
    result: {
      files: ["a.ts", "b.ts"],
      summary: "two files",
      nested: { deep: null },
    },
    input: { plan: { steps: 3 } },
    item: "a.ts",
    error: { name: "Scarn.Timeout", message: "took too long" },
    nodes: {
      evaluate: { result: { quality: 0.5 }, input: { companyNames: "Acme" } },
    },
    workItem: {
      title: "Bug",
      description: "It crashes",
      fields: { companyNames: "Acme" },
    },
  };

  test.concurrent("reads values from every source", () => {
    expect(resolveReferenceString("result.files.1", context)).toBe("b.ts");
    expect(resolveReferenceString("result.files.length", context)).toBe(2);
    expect(resolveReferenceString("result.summary.length", context)).toBe(9);
    expect(resolveReferenceString("result.nested.deep", context)).toBeNull();
    expect(resolveReferenceString("input.plan.steps", context)).toBe(3);
    expect(resolveReferenceString("item", context)).toBe("a.ts");
    expect(resolveReferenceString("error", context)).toEqual({
      name: "Scarn.Timeout",
      message: "took too long",
    });
    expect(resolveReferenceString("error.name", context)).toBe("Scarn.Timeout");
    expect(
      resolveReferenceString("nodes.evaluate.result.quality", context),
    ).toBe(0.5);
    expect(
      resolveReferenceString("nodes.evaluate.input.companyNames", context),
    ).toBe("Acme");
    expect(resolveReferenceString("workItem.title", context)).toBe("Bug");
    expect(resolveReferenceString("workItem.description", context)).toBe(
      "It crashes",
    );
    expect(
      resolveReferenceString("workItem.fields.companyNames", context),
    ).toBe("Acme");
  });

  test.concurrent("gives undefined for missing values", () => {
    expect(resolveReferenceString("result.missing.x", context)).toBeUndefined();
    expect(resolveReferenceString("result.files.9", context)).toBeUndefined();
    expect(
      resolveReferenceString("result.files.name", context),
    ).toBeUndefined();
    expect(
      resolveReferenceString("nodes.other.result", context),
    ).toBeUndefined();
    expect(
      resolveReferenceString("workItem.fields.nope", context),
    ).toBeUndefined();
    expect(resolveReferenceString("error", {})).toBeUndefined();
  });

  test.concurrent("resolves a work item with no description to null", () => {
    expect(
      resolveReferenceString("workItem.description", {
        workItem: { title: "Bug", description: null, fields: {} },
      }),
    ).toBeNull();
  });

  test.concurrent(
    "looks nodes up through a function, as the engine's visit walk does",
    () => {
      const lookups: string[] = [];
      const value = resolveReferenceString("nodes.fix.result.ok", {
        nodes: (id) => {
          lookups.push(id);
          return { result: { ok: true } };
        },
      });
      expect(value).toBe(true);
      expect(lookups).toEqual(["fix"]);
    },
  );

  test.concurrent("throws ReferenceError on a malformed reference", () => {
    expect(() => resolveReferenceString("oops", context)).toThrow(
      ReferenceError,
    );
    expect(() => resolveReferenceString("results", context)).toThrow(
      ReferenceError,
    );
  });

  test.concurrent("readPath does not read inherited properties", () => {
    expect(readPath({ a: 1 }, ["constructor"])).toBeUndefined();
  });
});

describe("resolveArgs", () => {
  test.concurrent(
    "resolves references and copies literals, dropping missing values",
    () => {
      const args = resolveArgs(
        {
          plan: "result",
          retries: { value: 3 },
          label: { value: "x" },
          missing: "result.nope",
        },
        { result: { summary: "s" } },
      );
      expect(args).toEqual({ plan: { summary: "s" }, retries: 3, label: "x" });
    },
  );

  test.concurrent(
    "resolves list args element by element, dropping missing elements",
    () => {
      const args = resolveArgs(
        {
          reviews: {
            list: ["result", { value: { ok: false } }, "result.nope"],
          },
        },
        { result: { ok: true } },
      );
      expect(args).toEqual({ reviews: [{ ok: true }, { ok: false }] });
    },
  );
});
