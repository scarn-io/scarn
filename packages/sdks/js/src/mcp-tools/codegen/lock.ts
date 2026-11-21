/**
 * The `<server>.lock.json` snapshot that `scarn mcp pull` writes: the tools a
 * server listed, verbatim, plus a content hash. The hash covers the server
 * and the tools only, not `listedAt`, so re-listing an unchanged server keeps
 * the same hash. Tools are sorted by name and object keys are written in a
 * stable order, so the file only changes when the server does.
 *
 * The lock holds tool names, titles, descriptions and schemas only; never
 * connection config, env or credentials.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  JsonSchemaObject,
  JsonValue,
} from "../../contracts/pipeline-document/json";
import { jsonFileDoc, printDoc } from "./doc-printer";

/** One tool as an MCP lister returns it; extra fields are ignored. */
export type ListedMcpToolInput = {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject | undefined;
};

export type McpToolLockTool = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
};

export type McpToolLock = {
  readonly version: 1;
  readonly server: string;
  readonly listedAt: string;
  /** `sha256:<hex>` over the canonical JSON of `server` and `tools`. */
  readonly hash: string;
  readonly tools: readonly McpToolLockTool[];
};

const jsonSchemaObject = z.record(z.string(), z.unknown());

const lockToolSchema = z.strictObject({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject.optional(),
});

const lockSchema = z.strictObject({
  version: z.literal(1),
  server: z.string().min(1),
  listedAt: z.string().min(1),
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  tools: z.array(lockToolSchema),
});

export function buildMcpToolLock(options: {
  readonly server: string;
  readonly listedAt: string | Date;
  readonly tools: readonly ListedMcpToolInput[];
}): McpToolLock {
  if (options.server.trim() === "") {
    throw new Error("buildMcpToolLock: server must not be empty");
  }
  const tools = [...options.tools]
    .map(lockTool)
    .sort((a, b) => compareStrings(a.name, b.name));
  const duplicate = tools.find(
    (tool, index) => index > 0 && tools[index - 1]?.name === tool.name,
  );
  if (duplicate !== undefined) {
    throw new Error(
      `buildMcpToolLock "${options.server}": the server listed the tool "${duplicate.name}" twice`,
    );
  }
  const listedAt =
    typeof options.listedAt === "string"
      ? options.listedAt
      : options.listedAt.toISOString();
  return {
    version: 1,
    server: options.server,
    listedAt,
    hash: mcpToolLockHash(options.server, tools),
    tools,
  };
}

/** Parses and validates a lock file's text; throws on a malformed or tampered lock. */
export function parseMcpToolLock(text: string): McpToolLock {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `MCP tool lock is not valid JSON: ${(error as Error).message}`,
    );
  }
  const parsed = lockSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `MCP tool lock is malformed: ${z.prettifyError(parsed.error)}`,
    );
  }
  const lock = parsed.data as McpToolLock;
  const expected = mcpToolLockHash(lock.server, lock.tools);
  if (lock.hash !== expected) {
    throw new Error(
      `MCP tool lock "${lock.server}" has hash ${lock.hash} but its content hashes to ${expected}; rerun \`scarn mcp pull\``,
    );
  }
  return lock;
}

/** The lock as file text: stable key order, prettier-clean, trailing newline. */
export function serializeMcpToolLock(lock: McpToolLock): string {
  const ordered: JsonValue = {
    version: lock.version,
    server: lock.server,
    listedAt: lock.listedAt,
    hash: lock.hash,
    tools: lock.tools.map((tool) => lockToolJson(tool)),
  };
  return `${printDoc(jsonFileDoc(ordered))}\n`;
}

/** The content hash of a server's tools, independent of order and `listedAt`. */
export function mcpToolLockHash(
  server: string,
  tools: readonly ListedMcpToolInput[],
): string {
  const content = canonicalJson({
    server,
    tools: [...tools]
      .map((tool) => lockToolJson(lockTool(tool)))
      .sort((a, b) => compareStrings(a.name, b.name)),
  });
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function lockTool(tool: ListedMcpToolInput): McpToolLockTool {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: structuredClone(tool.inputSchema),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: structuredClone(tool.outputSchema) }),
  };
}

function lockToolJson(tool: McpToolLockTool): {
  name: string;
  [key: string]: JsonValue;
} {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema as JsonValue,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema as JsonValue }),
  };
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
