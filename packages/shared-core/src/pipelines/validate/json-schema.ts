/**
 * The small subset of JSON Schema reasoning the validator needs: following
 * `$ref`, finding the schema at a data path, the set of types a schema
 * allows, and building root-independent schemas. Unknown or unconstrained schemas are treated as "any",
 * so the validator never reports an error it can't be sure of.
 */
import {
  type JsonSchema,
  type JsonSchemaObject,
  type JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";

export type SchemaType =
  "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";

/** A schema together with the document its `$ref`s resolve against. */
export interface RootedSchema {
  schema: JsonSchema;
  root: JsonSchema;
}

export const ANY: RootedSchema = { schema: true, root: true };

export function rooted(schema: JsonSchema): RootedSchema {
  return { schema, root: schema };
}

export function at(parent: RootedSchema, schema: JsonSchema): RootedSchema {
  return { schema, root: parent.root };
}

function resolvePointer(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#")) {
    return undefined;
  }
  let current: unknown = root;
  for (const raw of ref
    .slice(1)
    .split("/")
    .filter((segment) => segment.length > 0)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "boolean" ||
    (typeof current === "object" && current !== null)
    ? (current as JsonSchema)
    : undefined;
}

/** Follows `$ref` chains, then merges `allOf` members into one object when possible. */
export function deref(input: RootedSchema): RootedSchema {
  let current = input;
  const seen = new Set<string>();
  while (
    typeof current.schema === "object" &&
    typeof current.schema.$ref === "string"
  ) {
    const ref = current.schema.$ref;
    if (seen.has(ref)) {
      return { schema: true, root: current.root };
    }
    seen.add(ref);
    const target = resolvePointer(current.root, ref);
    if (target === undefined) {
      return { schema: true, root: current.root };
    }
    current = at(current, target);
  }
  const { schema } = current;
  if (
    typeof schema === "object" &&
    Array.isArray(schema.allOf) &&
    schema.allOf.length > 0
  ) {
    const merged: JsonSchemaObject = { ...schema, allOf: undefined };
    for (const member of schema.allOf) {
      const part = deref(at(current, member)).schema;
      if (typeof part === "object") {
        Object.assign(merged, part, {
          properties: { ...merged.properties, ...part.properties },
          required: [...(merged.required ?? []), ...(part.required ?? [])],
        });
      }
    }
    delete merged.allOf;
    return at(current, merged);
  }
  return current;
}

export function alternatives(input: RootedSchema): RootedSchema[] | null {
  const { schema } = deref(input);
  if (typeof schema !== "object") {
    return null;
  }
  const list = schema.anyOf ?? schema.oneOf;
  return Array.isArray(list) ? list.map((member) => at(input, member)) : null;
}

export function isAnySchema(input: RootedSchema): boolean {
  const { schema } = deref(input);
  if (schema === true) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  return typesOf(input) === null;
}

/** The types a schema allows, or null when it allows anything. */
export function typesOf(input: RootedSchema): Set<SchemaType> | null {
  const resolved = deref(input);
  const { schema } = resolved;
  if (schema === true) {
    return null;
  }
  if (schema === false) {
    return new Set();
  }
  const alts = alternatives(resolved);
  if (alts !== null) {
    const union = new Set<SchemaType>();
    for (const alt of alts) {
      const types = typesOf(alt);
      if (types === null) {
        return null;
      }
      types.forEach((type) => union.add(type));
    }
    return union;
  }
  if (schema.type !== undefined) {
    const list = (
      Array.isArray(schema.type) ? schema.type : [schema.type]
    ) as SchemaType[];
    return new Set(list);
  }
  const literals = schema.const !== undefined ? [schema.const] : schema.enum;
  if (Array.isArray(literals)) {
    return new Set(literals.map(typeOfValue));
  }
  if (schema.properties !== undefined) {
    return new Set(["object"]);
  }
  if (schema.items !== undefined || schema.prefixItems !== undefined) {
    return new Set(["array"]);
  }
  return null;
}

export function typeOfValue(value: JsonValue): SchemaType {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value as "string" | "boolean" | "object";
}

export function allowsType(input: RootedSchema, type: SchemaType): boolean {
  const types = typesOf(input);
  if (types === null) {
    return true;
  }
  return types.has(type) || (type === "integer" && types.has("number"));
}

/** True when every type the schema allows is in `allowed` (`integer` counts as `number`). */
export function onlyTypes(
  input: RootedSchema,
  allowed: readonly SchemaType[],
): boolean {
  const types = typesOf(input);
  if (types === null) {
    return true;
  }
  return [...types].every(
    (type) =>
      allowed.includes(type) ||
      (type === "integer" && allowed.includes("number")),
  );
}

/** Ignores a `null` member, for "string or null" fields that conditions still treat as strings. */
export function withoutNull(input: RootedSchema): RootedSchema {
  const alts = alternatives(input);
  if (alts === null) {
    return input;
  }
  const kept = alts.filter((alt) => {
    const types = typesOf(alt);
    return !(types !== null && types.size === 1 && types.has("null"));
  });
  return kept.length === 1 && kept[0] !== undefined ? kept[0] : input;
}

/** The schema of the value at `path` inside a value of `input`, or null if the path can't exist. */
export function schemaAtPath(
  input: RootedSchema,
  path: readonly string[],
): RootedSchema | null {
  if (path.length === 0) {
    return input;
  }
  const [head, ...rest] = path as [string, ...string[]];
  const resolved = deref(input);
  const { schema } = resolved;
  if (schema === true) {
    return ANY;
  }
  if (schema === false) {
    return null;
  }
  const alts = alternatives(resolved);
  if (alts !== null) {
    const found = alts
      .map((alt) => schemaAtPath(alt, path))
      .filter((child): child is RootedSchema => child !== null);
    if (found.length === 0) {
      return null;
    }
    if (found.length === 1 && found[0] !== undefined) {
      return found[0];
    }
    return {
      schema: { anyOf: found.map((child) => child.schema) },
      root: resolved.root,
    };
  }
  const types = typesOf(resolved);
  if (types === null) {
    return ANY;
  }
  if (head === "length" && (types.has("array") || types.has("string"))) {
    return schemaAtPath(at(resolved, { type: "integer" }), rest);
  }
  if (types.has("array") && /^\d+$/.test(head)) {
    const tuple = schema.prefixItems?.[Number(head)];
    const items = tuple ?? schema.items ?? true;
    return schemaAtPath(at(resolved, items), rest);
  }
  if (types.has("object")) {
    const property = schema.properties?.[head];
    if (property !== undefined) {
      return schemaAtPath(at(resolved, property), rest);
    }
    const additional = schema.additionalProperties;
    if (additional !== undefined && additional !== false) {
      return schemaAtPath(at(resolved, additional), rest);
    }
    if (schema.properties === undefined && additional === undefined) {
      return ANY;
    }
  }
  return null;
}

/** The property names an object schema declares (empty for non-object or open schemas). */
export function propertyNames(input: RootedSchema): string[] {
  const { schema } = deref(input);
  return typeof schema === "object" ? Object.keys(schema.properties ?? {}) : [];
}

export function itemsSchema(input: RootedSchema): RootedSchema {
  const resolved = deref(input);
  const alts = alternatives(resolved);
  if (alts !== null) {
    const arrays = alts.filter(
      (alt) => allowsType(alt, "array") && !isAnySchema(alt),
    );
    return arrays.length === 1 && arrays[0] !== undefined
      ? itemsSchema(arrays[0])
      : ANY;
  }
  const { schema } = resolved;
  return typeof schema === "object" && schema.items !== undefined
    ? at(resolved, schema.items)
    : ANY;
}

export function literalsOf(input: RootedSchema): JsonValue[] | null {
  const { schema } = deref(input);
  if (typeof schema !== "object") {
    return null;
  }
  if (schema.const !== undefined) {
    return [schema.const];
  }
  return Array.isArray(schema.enum) ? schema.enum : null;
}

/**
 * Copies a schema with every `$ref` replaced by its target, so it no longer
 * depends on its root. Recursive references are cut off as "any".
 */
export function inline(
  input: RootedSchema,
  seen: readonly string[] = [],
): JsonSchema {
  const { schema } = input;
  if (typeof schema !== "object") {
    return schema;
  }
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const target = seen.includes(ref)
      ? undefined
      : resolvePointer(input.root, ref);
    return target === undefined
      ? true
      : inline(at(input, target), [...seen, ref]);
  }
  const copy: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$defs" || key === "definitions") {
      continue;
    }
    if (key === "properties" && typeof value === "object" && value !== null) {
      copy.properties = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(
          ([name, child]) => [name, inline(at(input, child), seen)],
        ),
      );
    } else if (
      (key === "items" || key === "additionalProperties") &&
      (typeof value === "object" || typeof value === "boolean")
    ) {
      copy[key] = inline(at(input, value as JsonSchema), seen);
    } else if (
      (key === "anyOf" ||
        key === "oneOf" ||
        key === "allOf" ||
        key === "prefixItems") &&
      Array.isArray(value)
    ) {
      copy[key] = (value as JsonSchema[]).map((child) =>
        inline(at(input, child), seen),
      );
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

/** A root-independent union of schemas that may come from different documents. */
export function unionOf(members: readonly RootedSchema[]): RootedSchema {
  if (members.length === 1 && members[0] !== undefined) {
    return members[0];
  }
  if (members.some(isAnySchema)) {
    return ANY;
  }
  return rooted({ anyOf: members.map((member) => inline(member)) });
}

export function arrayOf(element: RootedSchema): RootedSchema {
  return rooted({ type: "array", items: inline(element) });
}
