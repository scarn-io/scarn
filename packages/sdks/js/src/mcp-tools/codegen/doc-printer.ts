/**
 * A tiny Wadler-style document printer that lays code out the way prettier
 * does (80 columns, 2-space indent, trailing commas, double quotes), so the
 * generated catalog and lock files are prettier-clean without depending on
 * prettier. It covers only the constructs the codegen emits: calls, object
 * and array literals, strings, numbers and comments.
 */
import type { JsonValue } from "../../contracts/pipeline-document/json";

export type Doc =
  | string
  | readonly Doc[]
  | { readonly type: "group"; readonly contents: Doc; readonly breaks: boolean }
  | { readonly type: "indent"; readonly contents: Doc }
  | { readonly type: "line"; readonly soft: boolean; readonly hard: boolean }
  | { readonly type: "ifBreak"; readonly broken: Doc; readonly flat: Doc };

const PRINT_WIDTH = 80;
const INDENT_WIDTH = 2;

export const line: Doc = { type: "line", soft: false, hard: false };
export const softline: Doc = { type: "line", soft: true, hard: false };
export const hardline: Doc = { type: "line", soft: false, hard: true };

export function group(contents: Doc, breaks = false): Doc {
  return {
    type: "group",
    contents,
    breaks: breaks || containsHardline(contents),
  };
}

export function indent(contents: Doc): Doc {
  return { type: "indent", contents };
}

export function ifBreak(broken: Doc, flat: Doc = ""): Doc {
  return { type: "ifBreak", broken, flat };
}

export function join(separator: Doc, docs: readonly Doc[]): Doc[] {
  return docs.flatMap((doc, index) => (index === 0 ? [doc] : [separator, doc]));
}

/** `{ a, b }`, broken over lines when it doesn't fit or `breaks` is set. */
export function objectDoc(
  entries: readonly (readonly [key: string, value: Doc])[],
  breaks = false,
): Doc {
  if (entries.length === 0) return "{}";
  const properties = entries.map(([key, value]) => propertyDoc(key, value));
  return group(
    [
      "{",
      indent([line, join([",", line], properties)]),
      ifBreak(","),
      line,
      "}",
    ],
    breaks,
  );
}

export function arrayDoc(items: readonly Doc[], breaks = false): Doc {
  if (items.length === 0) return "[]";
  return group(
    [
      "[",
      indent([softline, join([",", line], items)]),
      ifBreak(","),
      softline,
      "]",
    ],
    breaks,
  );
}

/** `callee(args)`; a lone object or array argument hugs the parentheses. */
export function callDoc(
  callee: string,
  args: readonly Doc[],
  hugLastArgument = false,
): Doc {
  if (args.length === 0) return `${callee}()`;
  const [only] = args;
  if (hugLastArgument && args.length === 1 && only !== undefined) {
    return [callee, "(", only, ")"];
  }
  return group([
    callee,
    "(",
    indent([softline, join([",", line], args)]),
    ifBreak(","),
    softline,
    ")",
  ]);
}

/** A TypeScript string literal, quoted the way prettier prefers. */
export function stringLiteral(value: string): string {
  const escaped = JSON.stringify(value).slice(1, -1);
  const doubles = value.split('"').length - 1;
  const singles = value.split("'").length - 1;
  if (doubles <= singles) return `"${escaped}"`;
  const unescaped = escaped
    .replace(/\\(.)/g, (match, char: string) => (char === '"' ? '"' : match))
    .replace(/'/g, "\\'");
  return `'${unescaped}'`;
}

/** An object key: bare when it's an identifier, quoted otherwise. */
export function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : stringLiteral(key);
}

/** A JSON value as a TypeScript literal. */
export function jsonLiteralDoc(value: JsonValue): Doc {
  if (value === null) return "null";
  if (typeof value === "string") return stringLiteral(value);
  if (typeof value === "number") return numberLiteral(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return arrayDoc(value.map(jsonLiteralDoc), shouldBreakArray(value));
  }
  return objectDoc(
    Object.entries(value).map(([key, item]) => [
      propertyKey(key),
      jsonLiteralDoc(item),
    ]),
  );
}

/**
 * A JSON document laid out as prettier formats a `.json` file: objects always
 * expanded, arrays only when they don't fit, no trailing commas.
 */
export function jsonFileDoc(value: JsonValue): Doc {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return group(
      [
        "[",
        indent([softline, join([",", line], value.map(jsonFileDoc))]),
        softline,
        "]",
      ],
      shouldBreakArray(value),
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  return group(
    [
      "{",
      indent([
        line,
        join(
          [",", line],
          entries.map(([key, item]) => [
            JSON.stringify(key),
            ": ",
            jsonFileDoc(item),
          ]),
        ),
      ]),
      line,
      "}",
    ],
    true,
  );
}

export function printDoc(doc: Doc): string {
  const out: string[] = [];
  let column = 0;
  const commands: Command[] = [[0, "break", doc]];
  for (let command = commands.pop(); command; command = commands.pop()) {
    const [indentation, mode, current] = command;
    if (typeof current === "string") {
      out.push(current);
      column += current.length;
    } else if (isDocArray(current)) {
      for (const item of [...current].reverse()) {
        commands.push([indentation, mode, item]);
      }
    } else if (current.type === "indent") {
      commands.push([indentation + INDENT_WIDTH, mode, current.contents]);
    } else if (current.type === "ifBreak") {
      commands.push([
        indentation,
        mode,
        mode === "break" ? current.broken : current.flat,
      ]);
    } else if (current.type === "group") {
      const flat: Command = [indentation, "flat", current.contents];
      const fitsFlat =
        mode === "flat" ||
        (!current.breaks && fits(flat, commands, PRINT_WIDTH - column));
      commands.push(
        fitsFlat && !current.breaks
          ? flat
          : [indentation, "break", current.contents],
      );
    } else if (mode === "flat" && !current.hard) {
      if (!current.soft) {
        out.push(" ");
        column += 1;
      }
    } else {
      trimTrailingSpaces(out);
      out.push(`\n${" ".repeat(indentation)}`);
      column = indentation;
    }
  }
  return out.join("");
}

type Mode = "flat" | "break";
type Command = readonly [indentation: number, mode: Mode, doc: Doc];

function fits(next: Command, rest: readonly Command[], width: number): boolean {
  let remaining = width;
  let restIndex = rest.length;
  const commands: Command[] = [next];
  while (remaining >= 0) {
    const command = commands.pop() ?? rest[--restIndex];
    if (command === undefined) return true;
    const [indentation, mode, current] = command;
    if (typeof current === "string") {
      remaining -= current.length;
    } else if (isDocArray(current)) {
      for (const item of [...current].reverse()) {
        commands.push([indentation, mode, item]);
      }
    } else if (current.type === "indent") {
      commands.push([indentation, mode, current.contents]);
    } else if (current.type === "ifBreak") {
      commands.push([
        indentation,
        mode,
        mode === "break" ? current.broken : current.flat,
      ]);
    } else if (current.type === "group") {
      commands.push([
        indentation,
        current.breaks ? "break" : mode,
        current.contents,
      ]);
    } else if (mode === "break" || current.hard) {
      return true;
    } else if (!current.soft) {
      remaining -= 1;
    }
  }
  return false;
}

function propertyDoc(key: string, value: Doc): Doc {
  if (typeof value === "string" && isStringLiteralText(value)) {
    const shortKey = key.length < INDENT_WIDTH + 3;
    return shortKey
      ? [key, ": ", value]
      : group([key, ":", group(indent([line, value]))]);
  }
  return [key, ": ", value];
}

function isStringLiteralText(text: string): boolean {
  return text.startsWith('"') || text.startsWith("'");
}

function shouldBreakArray(items: readonly JsonValue[]): boolean {
  if (items.length < 2) return false;
  const first = items[0];
  const firstIsArray = Array.isArray(first);
  return items.every((item) => {
    if (item === null || typeof item !== "object") return false;
    if (Array.isArray(item) !== firstIsArray) return false;
    return Array.isArray(item) ? item.length > 1 : Object.keys(item).length > 1;
  });
}

function numberLiteral(value: number): string {
  return JSON.stringify(value).replace("e+", "e");
}

function containsHardline(doc: Doc): boolean {
  if (typeof doc === "string") return false;
  if (isDocArray(doc)) return doc.some(containsHardline);
  switch (doc.type) {
    case "line":
      return doc.hard;
    case "group":
      return doc.breaks;
    case "indent":
      return containsHardline(doc.contents);
    case "ifBreak":
      return containsHardline(doc.broken) || containsHardline(doc.flat);
  }
}

function isDocArray(doc: Doc): doc is readonly Doc[] {
  return Array.isArray(doc);
}

function trimTrailingSpaces(out: string[]): void {
  for (let last = out.pop(); last !== undefined; last = out.pop()) {
    const trimmed = last.replace(/ +$/, "");
    if (trimmed.length > 0 || last.length === 0) {
      out.push(trimmed);
      return;
    }
  }
}
