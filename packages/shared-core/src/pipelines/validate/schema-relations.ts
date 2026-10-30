/**
 * Relations between JSON Schemas and values: whether one schema's values fit
 * another, whether a literal matches a schema, and short type descriptions
 * for error messages.
 */
import {
  deepEqual,
  isJsonObject,
  type JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  allowsType,
  alternatives,
  at,
  deref,
  isAnySchema,
  itemsSchema,
  literalsOf,
  typeOfValue,
  typesOf,
  type RootedSchema,
  type SchemaType,
} from "./json-schema";

/** `{ type: ["string", "null"] }` as one schema per type, so each can match a different `anyOf` member. */
function typeAlternatives(input: RootedSchema): RootedSchema[] | null {
  const resolved = deref(input);
  const { schema } = resolved;
  if (
    typeof schema !== "object" ||
    !Array.isArray(schema.type) ||
    schema.type.length < 2
  ) {
    return null;
  }
  return schema.type.map((type) => at(resolved, { ...schema, type }));
}

/** Whether every value of `source` is accepted by `target`, as far as the schemas say. */
export function isAssignable(
  source: RootedSchema,
  target: RootedSchema,
  depth = 0,
): boolean {
  if (depth > 20 || isAnySchema(target) || isAnySchema(source)) {
    return true;
  }
  const sourceAlts = alternatives(source) ?? typeAlternatives(source);
  if (sourceAlts !== null) {
    return sourceAlts.every((alt) => isAssignable(alt, target, depth + 1));
  }
  const targetAlts = alternatives(target);
  if (targetAlts !== null) {
    return targetAlts.some((alt) => isAssignable(source, alt, depth + 1));
  }
  const sourceTypes = typesOf(source) ?? new Set<SchemaType>();
  if (![...sourceTypes].every((type) => allowsType(target, type))) {
    return false;
  }
  const targetLiterals = literalsOf(target);
  if (targetLiterals !== null) {
    const sourceLiterals = literalsOf(source);
    return (
      sourceLiterals !== null &&
      sourceLiterals.every((value) =>
        targetLiterals.some((allowed) => deepEqual(allowed, value)),
      )
    );
  }
  const s = deref(source).schema;
  const t = deref(target).schema;
  if (typeof s !== "object" || typeof t !== "object") {
    return true;
  }
  if (sourceTypes.has("object")) {
    const sourceRequired = new Set(s.required ?? []);
    for (const name of t.required ?? []) {
      const declared = s.properties?.[name] !== undefined;
      if (
        !sourceRequired.has(name) &&
        (declared || s.additionalProperties === false)
      ) {
        return false;
      }
    }
    for (const [name, targetProperty] of Object.entries(t.properties ?? {})) {
      const sourceProperty = s.properties?.[name];
      if (
        sourceProperty !== undefined &&
        !isAssignable(
          at(source, sourceProperty),
          at(target, targetProperty),
          depth + 1,
        )
      ) {
        return false;
      }
    }
  }
  if (
    sourceTypes.has("array") &&
    s.items !== undefined &&
    t.items !== undefined
  ) {
    return isAssignable(at(source, s.items), at(target, t.items), depth + 1);
  }
  return true;
}

/** Whether a literal value is valid against a schema (types, const/enum, required, properties, items). */
export function valueMatches(
  value: JsonValue,
  input: RootedSchema,
  depth = 0,
): boolean {
  const resolved = deref(input);
  const { schema } = resolved;
  if (schema === true || depth > 20) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  const alts = alternatives(resolved);
  if (alts !== null) {
    return alts.some((alt) => valueMatches(value, alt, depth + 1));
  }
  if (!allowsType(resolved, typeOfValue(value))) {
    return false;
  }
  const literals = literalsOf(resolved);
  if (
    literals !== null &&
    !literals.some((allowed) => deepEqual(allowed, value))
  ) {
    return false;
  }
  if (isJsonObject(value)) {
    if ((schema.required ?? []).some((name) => !Object.hasOwn(value, name))) {
      return false;
    }
    return Object.entries(value).every(([name, child]) => {
      const property = schema.properties?.[name] ?? schema.additionalProperties;
      return property === undefined
        ? true
        : valueMatches(child, at(resolved, property), depth + 1);
    });
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    return value.every((child) =>
      valueMatches(child, at(resolved, items), depth + 1),
    );
  }
  return true;
}

/** A short type description for messages, preferring the schema's `title`. */
export function describeSchema(input: RootedSchema): string {
  const resolved = deref(input);
  const { schema } = resolved;
  if (typeof schema === "object" && typeof schema.title === "string") {
    return schema.title;
  }
  const literals = literalsOf(resolved);
  if (literals !== null) {
    return literals.map((value) => JSON.stringify(value)).join(" | ");
  }
  const alts = alternatives(resolved);
  if (alts !== null) {
    return alts.map(describeSchema).join(" | ");
  }
  const types = typesOf(resolved);
  if (types === null) {
    return "any";
  }
  if (types.has("array") && types.size === 1) {
    return `${describeSchema(itemsSchema(resolved))}[]`;
  }
  return [...types].join(" | ");
}
