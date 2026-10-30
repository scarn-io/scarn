/**
 * ESLint plugin for pipeline files written with `@scarn/sdk/pipelines`.
 *
 * Pipeline callbacks (`when`, `to` and `otherwise` in `.next(...)`, `.catch`
 * and `each`'s start) run once, at build time, with references in place of
 * values. `.partial(args)` takes no callback; its args are checked as part of
 * the `.next(...)` callback that builds them. JavaScript logic on a reference doesn't branch at run time, so
 * `no-logic-in-pipeline-callbacks` reports `?:`, `&&`, `||`, `??`, `!`,
 * comparisons and `if` statements written directly in such a callback.
 *
 * Scope:
 * - Only the callback's own body is checked. Functions nested inside it, such
 *   as the item callbacks of `some`, `every` and `none`, are not.
 * - `.catch` is only treated as a pipeline call with two arguments (`on`,
 *   `target`), so a Promise's one-argument `.catch(handler)` isn't reported.
 * - `.next` is only treated as a pipeline call with one argument: a function,
 *   or an object literal with `routes` / `otherwise`. An iterator's
 *   `.next()` or `.next(value)` isn't reported.
 * - `each` must be called as a plain identifier with an array reference and a
 *   start callback; a method named `each` isn't reported.
 *
 * Usage (flat config):
 * ```js
 * import scarn from "@scarn/sdk/eslint";
 * export default [scarn.configs.recommended];
 * ```
 *
 * The plugin has no runtime dependencies; `eslint` is only a type import.
 */
import type { ESLint, Linter, Rule } from "eslint";

type Listener<K extends keyof Rule.NodeListener> = NonNullable<
  Rule.NodeListener[K]
>;
type CallExpression = Parameters<Listener<"CallExpression">>[0];
type BinaryExpression = Parameters<Listener<"BinaryExpression">>[0];
type UnaryExpression = Parameters<Listener<"UnaryExpression">>[0];
type Expression = CallExpression["arguments"][number];

const comparisonOperators = new Set([
  "<",
  ">",
  "<=",
  ">=",
  "==",
  "===",
  "!=",
  "!==",
]);

function isFunction(node: Expression | undefined): boolean {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression"
  );
}

function propertyNamed(
  object: Expression | undefined,
  name: string,
): Expression | undefined {
  if (object?.type !== "ObjectExpression") {
    return undefined;
  }
  for (const property of object.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" && property.key.name === name) ||
        (property.key.type === "Literal" && property.key.value === name))
    ) {
      return property.value as Expression;
    }
  }
  return undefined;
}

function nextCallbacks(arg: Expression | undefined): Expression[] {
  if (isFunction(arg)) {
    return [arg as Expression];
  }
  const routes = propertyNamed(arg, "routes");
  const otherwise = propertyNamed(arg, "otherwise");
  if (routes === undefined && otherwise === undefined) {
    return [];
  }
  const fromRoutes =
    routes?.type === "ArrayExpression"
      ? routes.elements.flatMap((route) =>
          route === null || route.type === "SpreadElement"
            ? []
            : [propertyNamed(route, "when"), propertyNamed(route, "to")],
        )
      : [];
  return [...fromRoutes, otherwise].filter((node) =>
    isFunction(node),
  ) as Expression[];
}

function pipelineCallbacks(call: CallExpression): Expression[] {
  const { callee } = call;
  const args = call.arguments;
  if (callee.type === "Identifier" && callee.name === "each") {
    const start = args.at(-1);
    return args.length >= 2 && isFunction(start) ? [start as Expression] : [];
  }
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier"
  ) {
    return [];
  }
  const method = callee.property.name;
  if (method === "next" && args.length === 1) {
    return nextCallbacks(args[0]);
  }
  if (method === "catch" && args.length === 2) {
    return isFunction(args[1]) ? [args[1] as Expression] : [];
  }
  return [];
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow JavaScript logic inside pipeline callbacks, which run once at build time on references",
    },
    schema: [],
    messages: {
      logic:
        "{{kind}} in a pipeline callback runs once at build time on a reference, not at run time. Branch with `.next({ routes: [{ when, to }] })` and a condition helper (`equal`, `all`, `not`, ...) instead.",
    },
  },
  create(context) {
    const callbacks = new WeakSet();

    function report(node: Rule.Node, kind: string): void {
      let current: Rule.Node | null = node.parent;
      while (current !== null) {
        if (
          current.type === "ArrowFunctionExpression" ||
          current.type === "FunctionExpression" ||
          current.type === "FunctionDeclaration"
        ) {
          if (callbacks.has(current)) {
            context.report({ node, messageId: "logic", data: { kind } });
          }
          return;
        }
        current = current.parent;
      }
    }

    return {
      CallExpression(node) {
        for (const callback of pipelineCallbacks(node)) {
          callbacks.add(callback);
        }
      },
      ConditionalExpression(node) {
        report(node, "A conditional (`?:`)");
      },
      LogicalExpression(node) {
        report(node, `\`${node.operator}\``);
      },
      BinaryExpression(node: BinaryExpression & Rule.NodeParentExtension) {
        if (comparisonOperators.has(node.operator)) {
          report(node, `A comparison (\`${node.operator}\`)`);
        }
      },
      UnaryExpression(node: UnaryExpression & Rule.NodeParentExtension) {
        if (node.operator === "!") {
          report(node, "`!`");
        }
      },
      IfStatement(node) {
        report(node, "An `if` statement");
      },
    };
  },
};

const plugin = {
  meta: { name: "@scarn/sdk/eslint" },
  rules: { "no-logic-in-pipeline-callbacks": rule },
  configs: {} as Record<"recommended", Linter.Config>,
} satisfies ESLint.Plugin;

plugin.configs.recommended = {
  name: "@scarn/sdk/eslint/recommended",
  plugins: { scarn: plugin },
  rules: { "scarn/no-logic-in-pipeline-callbacks": "error" },
};

export { rule as noLogicInPipelineCallbacks };
export default plugin;
