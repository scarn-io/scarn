import { describe, expect, it } from "bun:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import plugin, { noLogicInPipelineCallbacks } from "@scarn/sdk/eslint";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
});

const error = (type: string) => ({ messageId: "logic", type });

ruleTester.run("no-logic-in-pipeline-callbacks", noLogicInPipelineCallbacks, {
  valid: [
    {
      name: "condition helpers and refs in .next routes",
      code: `step.next({
        routes: [
          { when: (r) => all(equal(r.result.ok, true), greaterThan(r.result.n, 1)), to: (r) => next({ x: r.result.x }) },
          { when: (r) => not(isEmpty(r.result.files)), to: done },
        ],
        otherwise: (r) => review({ input: r.input }),
      });`,
    },
    {
      name: "nested item callbacks of some/every are not checked",
      code: `step.next({
        routes: [{ when: (r) => some(r.result.items, (x) => equal(x.ok, true)), to: (r) => next(r.result.items.map((i) => i.a || i.b)) }],
        otherwise: done,
      });`,
    },
    {
      name: "each with options and a partial target",
      code: `step.next((r) => each(r.result.files, { maxConcurrency: 2 }, (file) => edit({ file })));
      edit.next((r) => merge.partial({ edits: [r.result] }));`,
    },
    {
      name: "pipeline .catch with a plain target",
      code: `step.catch(["Scarn.Timeout"], (r) => retry({ error: r.error }));`,
    },
    {
      name: "a Promise's one-argument .catch is not a pipeline call",
      code: `promise.catch((e) => (e ? a : b));`,
    },
    {
      name: "a method named each is not the pipeline each",
      code: `list.each((x) => { if (x > 1) log(x); });`,
    },
    {
      name: "logic outside a callback",
      code: `const ok = a && b ? 1 : 2; if (!ok) step.next(done);`,
    },
    {
      name: "an iterator's .next is not a pipeline call",
      code: `iterator.next(a && b); iterator.next({ value: a ? 1 : 2 });`,
    },
  ],
  invalid: [
    {
      name: "?: in .next(target)",
      code: `step.next((r) => (r.result.ok ? a : b));`,
      errors: [error("ConditionalExpression")],
    },
    {
      name: "&& in a route's when",
      code: `step.next({ routes: [{ when: (r) => r.result.a && r.result.b, to: next }], otherwise: done });`,
      errors: [error("LogicalExpression")],
    },
    {
      name: "|| and ?? in a route's to",
      code: `step.next({ routes: [{ when: c, to: a }, { when: c, to: (r) => next({ x: (r.result.a || r.result.b) ?? "" }) }], otherwise: done });`,
      errors: [error("LogicalExpression"), error("LogicalExpression")],
    },
    {
      name: "comparisons in a when and in otherwise",
      code: `step.next({ routes: [{ when: (r) => r.result.n > 1, to: a }], otherwise: (r) => (r.result.n === 0, done) });`,
      errors: [error("BinaryExpression"), error("BinaryExpression")],
    },
    {
      name: "every comparison operator",
      code: `step.next((r) => [r.a < 1, r.a <= 1, r.a >= 1, r.a == 1, r.a != 1, r.a !== 1]);`,
      errors: Array.from({ length: 6 }, () => error("BinaryExpression")),
    },
    {
      name: "! in a when",
      code: `step.next({ routes: [{ when: c, to: a }, { when: (r) => !r.result.ok, to: b }], otherwise: done });`,
      errors: [error("UnaryExpression")],
    },
    {
      name: "if statement in a function expression passed to .next",
      code: `step.next(function (r) { if (r.result.ok) { return a; } return b; });`,
      errors: [error("IfStatement")],
    },
    {
      name: "pipeline .catch target",
      code: `step.catch(["Scarn.Timeout"], (r) => (r.error ? a : b));`,
      errors: [error("ConditionalExpression")],
    },
    {
      name: "each start callback",
      code: `each(r.result.files, (file) => (file ? edit({ file }) : done));`,
      errors: [error("ConditionalExpression")],
    },
    {
      name: "each start callback, with options",
      code: `each(r.result.files, { maxConcurrency: 2 }, (file) => edit({ file: file.path ?? "" }));`,
      errors: [error("LogicalExpression")],
    },
    {
      name: "logic in the .next callback building a .partial target",
      code: `edit.next((r) => merge.partial({ edits: r.result.ok ? [r.result] : [] }));`,
      errors: [error("ConditionalExpression")],
    },
  ],
});

describe("plugin", () => {
  it("exposes the rule and a recommended flat config", () => {
    expect(plugin.rules["no-logic-in-pipeline-callbacks"]).toBe(
      noLogicInPipelineCallbacks,
    );
    expect(plugin.configs.recommended.plugins?.["scarn"]).toBe(plugin);
    expect(plugin.configs.recommended.rules).toEqual({
      "scarn/no-logic-in-pipeline-callbacks": "error",
    });
  });
});
