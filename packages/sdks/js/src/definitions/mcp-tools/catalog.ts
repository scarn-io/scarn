/**
 * Tool catalogs: the tool names and schemas of one MCP server, with no
 * connection config (ADR 0014). `scarn mcp pull` generates them; a catalog
 * is bound to a server with `defineMcp(...).withTools(catalog)`.
 *
 * Each tool keeps its zod types (for TypeScript inference) next to the JSON
 * Schemas the step compiles to, so compiling never round-trips through zod.
 * A generated catalog passes the server's original JSON Schemas verbatim; a
 * hand-written tool may omit them, and they are then derived from zod.
 */
import type { ZodType } from "zod";
import { toJSONSchema, type $ZodType } from "zod/v4/core";
import type { JsonSchema } from "../../contracts/pipeline-document/json";

type McpToolBaseOptions<TInput extends ZodType> = {
  /** The tool's name on the server, as in `tools/call`. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** The tool's arguments. MCP requires every tool to declare one. */
  readonly input: TInput;
  /** The original JSON Schema behind `input`; derived from `input` when omitted. */
  readonly inputJsonSchema?: JsonSchema;
};

export type McpToolWithOutputOptions<
  TInput extends ZodType,
  TOutput extends ZodType,
> = McpToolBaseOptions<TInput> & {
  /** The tool's `structuredContent`, when the server declares an output schema. */
  readonly output: TOutput;
  /** The original JSON Schema behind `output`; derived from `output` when omitted. */
  readonly outputJsonSchema?: JsonSchema;
};

export type McpToolWithoutOutputOptions<TInput extends ZodType> =
  McpToolBaseOptions<TInput> & {
    readonly output?: undefined;
    readonly outputJsonSchema?: undefined;
  };

/** One catalog entry: a tool's name plus its input and (optional) output schemas. */
export type McpTool<
  TInput extends ZodType = ZodType,
  TOutput extends ZodType | undefined = ZodType | undefined,
> = {
  readonly kind: "mcpTool";
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly input: TInput;
  readonly inputJsonSchema: JsonSchema;
  readonly output: TOutput;
  /** `null` exactly when `output` is `undefined`. */
  readonly outputJsonSchema: JsonSchema | null;
};

/** Where a catalog came from: the server it was pulled from and its lock's hash. */
export type McpToolCatalogSource = {
  readonly server: string;
  readonly lockHash?: string;
};

export type McpToolCatalog<
  TTools extends Record<string, McpTool> = Record<string, McpTool>,
> = {
  readonly kind: "mcpToolCatalog";
  readonly source: McpToolCatalogSource;
  readonly tools: Readonly<TTools>;
};

export type McpToolInput<T extends McpTool> =
  T extends McpTool<infer TInput> ? TInput : never;

export type McpToolOutput<T extends McpTool> =
  T extends McpTool<ZodType, infer TOutput> ? TOutput : never;

export function mcpTool<TInput extends ZodType, TOutput extends ZodType>(
  options: McpToolWithOutputOptions<TInput, TOutput>,
): McpTool<TInput, TOutput>;
export function mcpTool<TInput extends ZodType>(
  options: McpToolWithoutOutputOptions<TInput>,
): McpTool<TInput, undefined>;
export function mcpTool(
  options: McpToolBaseOptions<ZodType> & {
    readonly output?: ZodType;
    readonly outputJsonSchema?: JsonSchema;
  },
): McpTool {
  if (options.name.trim() === "") {
    throw new Error("mcpTool: name must not be empty");
  }
  const output = options.output;
  if (output === undefined && options.outputJsonSchema !== undefined) {
    throw new Error(
      `mcpTool "${options.name}": outputJsonSchema needs an output zod type`,
    );
  }
  return Object.freeze({
    kind: "mcpTool",
    name: options.name,
    title: options.title ?? null,
    description: options.description ?? null,
    input: options.input,
    inputJsonSchema: frozenJsonSchema(
      options.inputJsonSchema ?? zodToJsonSchema(options.input),
    ),
    output,
    outputJsonSchema:
      output === undefined
        ? null
        : frozenJsonSchema(options.outputJsonSchema ?? zodToJsonSchema(output)),
  });
}

export function mcpToolCatalog<
  TTools extends Record<string, McpTool>,
>(options: {
  readonly source: McpToolCatalogSource;
  readonly tools: TTools;
}): McpToolCatalog<TTools> {
  if (options.source.server.trim() === "") {
    throw new Error("mcpToolCatalog: source.server must not be empty");
  }
  const tools: Record<string, McpTool> = {};
  const byName = new Map<string, string>();
  for (const [key, tool] of Object.entries(options.tools)) {
    if (!isMcpTool(tool)) {
      throw new Error(
        `mcpToolCatalog "${options.source.server}": tools.${key} must be made with mcpTool()`,
      );
    }
    const clash = byName.get(tool.name);
    if (clash !== undefined) {
      throw new Error(
        `mcpToolCatalog "${options.source.server}": tools.${clash} and tools.${key} both name the tool "${tool.name}"`,
      );
    }
    byName.set(tool.name, key);
    tools[key] = tool;
  }
  return Object.freeze({
    kind: "mcpToolCatalog",
    source: Object.freeze({ ...options.source }),
    tools: Object.freeze(tools) as Readonly<TTools>,
  });
}

// eslint-disable-next-line local/no-unknown-parameter-type
export function isMcpTool(value: unknown): value is McpTool {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "mcpTool"
  );
}

// eslint-disable-next-line local/no-unknown-parameter-type
export function isMcpToolCatalog(value: unknown): value is McpToolCatalog {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "mcpToolCatalog"
  );
}

function zodToJsonSchema(schema: ZodType): JsonSchema {
  return toJSONSchema(schema as unknown as $ZodType) as JsonSchema;
}

function frozenJsonSchema(schema: JsonSchema): JsonSchema {
  return deepFreeze(structuredClone(schema));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
