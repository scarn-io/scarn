/**
 * Turns a tool's JSON Schema into zod source code, for TypeScript types only:
 * the generated catalog embeds the original JSON Schema, which is what
 * validates at runtime. So only the shape is translated (types, properties,
 * required, enums, unions, nullability); constraints such as `minLength` or
 * `format` are left to the JSON Schema.
 *
 * Anything without a faithful zod shape (`patternProperties`, `$ref` cycles,
 * remote `$ref`s, conditionals…) becomes `z.unknown()` with an
 * `/* unsupported: … *\/` comment for that subtree.
 */
import type {
  JsonSchema,
  JsonSchemaObject,
  JsonValue,
} from "../../contracts/pipeline-document/json";
import {
  arrayDoc,
  callDoc,
  objectDoc,
  propertyKey,
  stringLiteral,
  type Doc,
} from "./doc-printer";

export type JsonSchemaToZodResult = {
  readonly doc: Doc;
  /** One entry per subtree that fell back to `z.unknown()`. */
  readonly unsupported: readonly string[];
};

const UNSUPPORTED_KEYWORDS = [
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentSchemas",
  "dependencies",
  "prefixItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "$dynamicRef",
  "$recursiveRef",
] as const;

const PRIMITIVE_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "object",
  "array",
]);

export function jsonSchemaToZod(schema: JsonSchema): JsonSchemaToZodResult {
  const unsupported: string[] = [];
  const context: Context = { root: schema, refStack: [], unsupported };
  return { doc: convert(schema, context), unsupported };
}

type Context = {
  readonly root: JsonSchema;
  readonly refStack: readonly string[];
  readonly unsupported: string[];
};

function convert(schema: JsonSchema, context: Context): Doc {
  if (schema === true) return "z.unknown()";
  if (schema === false) return "z.never()";
  if (typeof schema.$ref === "string") return convertRef(schema, context);

  const keyword = UNSUPPORTED_KEYWORDS.find((key) => schema[key] !== undefined);
  if (keyword !== undefined) return unsupported(keyword, context);

  const nullable = schema["nullable"] === true;
  const doc = convertNonNullable(schema, context);
  return nullable ? callDoc("z.nullable", [doc]) : doc;
}

function convertNonNullable(schema: JsonSchemaObject, context: Context): Doc {
  if (schema.const !== undefined) return literal(schema.const, context);
  if (Array.isArray(schema.enum)) return enumDoc(schema.enum, context);

  if (Array.isArray(schema.allOf)) {
    const [only] = schema.allOf;
    if (
      schema.allOf.length !== 1 ||
      only === undefined ||
      hasShapeKeywords(schema)
    ) {
      return unsupported("allOf", context);
    }
    return convert(only, context);
  }

  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (variants !== undefined) {
    if (hasShapeKeywords(schema)) {
      return unsupported(
        schema.anyOf === undefined
          ? "oneOf with siblings"
          : "anyOf with siblings",
        context,
      );
    }
    return union(
      variants.map((variant) => convert(variant, context)),
      context,
    );
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    const types = [...new Set(type)];
    if (types.some((item) => !PRIMITIVE_TYPES.has(item))) {
      return unsupported(`type ${JSON.stringify(type)}`, context);
    }
    const nonNull = types.filter((item) => item !== "null");
    const docs = nonNull.map((item) => convertTyped(item, schema, context));
    const inner = union(docs, context);
    return types.includes("null") && nonNull.length > 0
      ? callDoc("z.nullable", [inner])
      : nonNull.length === 0
        ? "z.null()"
        : inner;
  }
  if (typeof type === "string") {
    if (!PRIMITIVE_TYPES.has(type)) {
      return unsupported(`type "${type}"`, context);
    }
    return convertTyped(type, schema, context);
  }
  if (
    schema.properties !== undefined ||
    schema.additionalProperties !== undefined ||
    Array.isArray(schema.required)
  ) {
    return convertTyped("object", schema, context);
  }
  if (schema.items !== undefined) return convertTyped("array", schema, context);
  return "z.unknown()";
}

function convertTyped(
  type: string,
  schema: JsonSchemaObject,
  context: Context,
): Doc {
  switch (type) {
    case "string":
      return "z.string()";
    case "number":
      return "z.number()";
    case "integer":
      return "z.int()";
    case "boolean":
      return "z.boolean()";
    case "null":
      return "z.null()";
    case "array":
      return arrayType(schema, context);
    default:
      return objectType(schema, context);
  }
}

function arrayType(schema: JsonSchemaObject, context: Context): Doc {
  const items = schema.items;
  if (Array.isArray(items)) return unsupported("tuple items", context);
  return callDoc("z.array", [
    items === undefined ? "z.unknown()" : convert(items, context),
  ]);
}

function objectType(schema: JsonSchemaObject, context: Context): Doc {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const entries = Object.entries(properties).map(
    ([key, property]): readonly [string, Doc] => {
      const doc = convert(property, context);
      return [
        propertyKey(key),
        required.has(key) ? doc : callDoc("z.optional", [doc]),
      ];
    },
  );
  const additional = schema.additionalProperties;
  if (entries.length === 0 && isSchema(additional) && additional !== false) {
    return callDoc("z.record", [
      "z.string()",
      additional === true ? "z.unknown()" : convert(additional, context),
    ]);
  }
  const constructor =
    additional === false
      ? "z.strictObject"
      : additional === undefined || additional === true
        ? "z.object"
        : "z.looseObject";
  return callDoc(constructor, [objectDoc(entries)], true);
}

function convertRef(schema: JsonSchemaObject, context: Context): Doc {
  const ref = schema.$ref as string;
  if (context.refStack.includes(ref)) {
    return unsupported(`recursive $ref ${ref}`, context);
  }
  const target = resolveLocalRef(context.root, ref);
  if (target === undefined) {
    return unsupported(`unresolved $ref ${ref}`, context);
  }
  const nested: Context = { ...context, refStack: [...context.refStack, ref] };
  const doc = convert(target, nested);
  return schema["nullable"] === true ? callDoc("z.nullable", [doc]) : doc;
}

function resolveLocalRef(
  root: JsonSchema,
  ref: string,
): JsonSchema | undefined {
  if (ref !== "#" && !ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of ref
    .slice(2)
    .split("/")
    .filter((part) => part !== "")) {
    const segment = decodeURIComponent(raw)
      .replace(/~1/g, "/")
      .replace(/~0/g, "~");
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return isSchema(current) ? current : undefined;
}

function enumDoc(values: readonly JsonValue[], context: Context): Doc {
  if (values.length === 0) return "z.never()";
  if (values.every((value) => typeof value === "string")) {
    return callDoc(
      "z.enum",
      [arrayDoc([...new Set(values)].map(stringLiteral))],
      true,
    );
  }
  return union(
    values.map((value) => literal(value, context)),
    context,
  );
}

function literal(value: JsonValue, context: Context): Doc {
  if (value === null) return "z.null()";
  if (typeof value === "object") return unsupported("object const", context);
  return callDoc("z.literal", [
    typeof value === "string" ? stringLiteral(value) : JSON.stringify(value),
  ]);
}

function union(docs: readonly Doc[], context: Context): Doc {
  const [first] = docs;
  if (first === undefined) return unsupported("empty union", context);
  if (docs.length === 1) return first;
  return callDoc("z.union", [arrayDoc(docs)], true);
}

function unsupported(feature: string, context: Context): Doc {
  context.unsupported.push(feature);
  return `z.unknown() /* unsupported: ${feature.replace(/\*\//g, "* /")} */`;
}

function hasShapeKeywords(schema: JsonSchemaObject): boolean {
  return (
    schema.type !== undefined ||
    schema.properties !== undefined ||
    schema.items !== undefined
  );
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || isPlainObject(value);
}

// eslint-disable-next-line local/no-unknown-parameter-type
function isPlainObject(value: unknown): value is Record<string, JsonSchema> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
