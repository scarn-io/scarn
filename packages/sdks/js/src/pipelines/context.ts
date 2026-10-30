/**
 * The `r` objects passed to chain callbacks. Each property read creates a
 * fresh root placeholder, so reads are tracked from the root, and each `r`
 * owns its placeholders: using `r.result` from another node's callback is an
 * error, because it would compile to the wrong node's `result`.
 */
import type { JsonSchema } from "../contracts/pipeline-document";
import {
  CONVERSATION_RESULT_SCHEMA,
  ERROR_SCHEMA,
} from "../contracts/pipeline-document";
import type { NodeDef } from "./model";
import { requireNode } from "./registry";
import { rootPlaceholder } from "./refs";

function schemaOf(
  node: NodeDef,
  source: "result" | "input",
): JsonSchema | undefined {
  if (node.kind === "step") {
    if (source === "result" && node.conversation) {
      return CONVERSATION_RESULT_SCHEMA;
    }
    return (
      (source === "result" ? node.resultSchema : node.inputSchema) ?? undefined
    );
  }
  if (node.kind === "wait") {
    return source === "result"
      ? node.resultSchema
      : (node.inputSchema ?? undefined);
  }
  return undefined;
}

function reach(target: object): object {
  const node = requireNode(target, "r.node(...)");
  if (node.kind !== "step" && node.kind !== "wait") {
    throw new Error(
      `r.node("${node.id}"): ${node.kind} nodes have no result or input`,
    );
  }
  return {
    get result() {
      return rootPlaceholder(
        `nodes.${node.id}.result`,
        schemaOf(node, "result"),
        { reach: node.id },
      );
    },
    get input() {
      return rootPlaceholder(
        `nodes.${node.id}.input`,
        schemaOf(node, "input"),
        { reach: node.id },
      );
    },
  };
}

export type ContextKind = "next" | "catch";

/** The `r` for a callback on `node`'s chain. */
export function makeContext(node: NodeDef, kind: ContextKind): object {
  const context: Record<string, unknown> = { node: reach };
  const owned = (path: string, schema: JsonSchema | undefined) => ({
    get: () => rootPlaceholder(path, schema, { owner: context }),
    enumerable: true,
  });
  if (kind === "next") {
    Object.defineProperties(context, {
      result: owned("result", schemaOf(node, "result")),
      input: owned("input", schemaOf(node, "input")),
    });
  } else {
    Object.defineProperties(context, {
      error: owned("error", ERROR_SCHEMA),
      input: owned("input", schemaOf(node, "input")),
    });
  }
  return context;
}

/** The `item` parameter of an `each` start callback, and its owner token. */
export function makeItem(itemsSchema: JsonSchema | undefined): {
  item: object;
  owner: object;
} {
  const owner = {};
  return { item: rootPlaceholder("item", itemsSchema, { owner }), owner };
}
