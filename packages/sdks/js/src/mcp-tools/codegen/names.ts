/**
 * Names for a pulled server's files, its catalog export and the catalog's
 * property keys.
 */

/** `notion` → `notion.lock.json`. */
export function mcpToolLockFileName(server: string): string {
  return `${server}.lock.json`;
}

/** `notion` → `notion.tools.ts`. */
export function mcpToolCatalogFileName(server: string): string {
  return `${server}.tools.ts`;
}

/** `notion` → `notionTools`; `my-server` → `myServerTools`. */
export function mcpToolCatalogExportName(server: string): string {
  const name = safeKey(`${camelCase(server)}Tools`, "server");
  return RESERVED.has(name) ? `${name}_` : name;
}

export type McpToolKey = {
  readonly name: string;
  readonly key: string;
};

export type McpToolKeys = {
  readonly keys: readonly McpToolKey[];
  readonly warnings: readonly string[];
};

/**
 * Catalog keys for a server's tools, in the given order. A leading
 * `<server>-` / `<server>_` is stripped (`notion-search` → `search`), the
 * rest is camel-cased, and collisions get a numeric suffix with a warning.
 */
export function mcpToolKeys(
  server: string,
  toolNames: readonly string[],
): McpToolKeys {
  const warnings: string[] = [];
  const taken = new Set<string>();
  const keys = toolNames.map((name) => {
    const base = safeKey(camelCase(stripServerPrefix(server, name)), "tool");
    let key = base;
    for (let suffix = 2; taken.has(key); suffix++) {
      key = `${base}${String(suffix)}`;
    }
    if (key !== base) {
      warnings.push(
        `MCP tool "${name}" maps to catalog key "${base}", which is taken; using "${key}"`,
      );
    }
    taken.add(key);
    return { name, key };
  });
  return { keys, warnings };
}

function stripServerPrefix(server: string, name: string): string {
  for (const separator of ["-", "_"]) {
    const prefix = `${server}${separator}`;
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

function camelCase(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0);
  return words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
}

const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
]);

function safeKey(value: string, fallback: string): string {
  if (value === "") return fallback;
  if (/^[0-9]/.test(value)) return `_${value}`;
  if (value === "__proto__") return "proto";
  return value;
}
