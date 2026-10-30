/**
 * Parses reference strings such as `result.files`, `nodes.fix.input.plan`
 * or `workItem.fields.companyNames` into a structured {@link Reference}.
 *
 * References are plain data paths: segments are separated by `.`, a numeric
 * segment indexes an array, and `length` on an array or string gives its
 * length. Nothing is ever evaluated as code.
 */
export type Reference =
  | { kind: "result"; path: string[] }
  | { kind: "input"; path: string[] }
  | { kind: "item"; path: string[] }
  | { kind: "error"; path: string[] }
  | { kind: "node"; nodeId: string; source: "result" | "input"; path: string[] }
  | { kind: "workItemTitle" }
  | { kind: "workItemDescription" }
  | { kind: "workItemField"; alias: string; path: string[] };

export type ReferenceKind = Reference["kind"];

export type ParseReferenceResult =
  | { ok: true; reference: Reference }
  | { ok: false; message: string; hint?: string };

export const ERROR_FIELDS = ["name", "message", "cause"] as const;

const ROOTS = ["result", "input", "item", "error", "nodes", "workItem"];

function fail(message: string, hint?: string): ParseReferenceResult {
  return hint === undefined
    ? { ok: false, message }
    : { ok: false, message, hint };
}

/** Splits a relative data path (`a.b.0`) into segments, or null if a segment is empty. */
export function splitPath(path: string): string[] | null {
  const segments = path.split(".");
  return segments.some((segment) => segment.length === 0) ? null : segments;
}

export function parseReference(text: string): ParseReferenceResult {
  if (text.trim() !== text || text.length === 0) {
    return fail(
      `"${text}" is not a valid reference: it has leading or trailing spaces or is empty`,
    );
  }
  const segments = splitPath(text);
  if (segments === null) {
    return fail(
      `"${text}" is not a valid reference: it has an empty path segment`,
    );
  }
  const [root, ...rest] = segments as [string, ...string[]];
  switch (root) {
    case "result":
    case "input":
    case "item":
      return { ok: true, reference: { kind: root, path: rest } };
    case "error": {
      const [field, ...extra] = rest;
      if (field === undefined) {
        return { ok: true, reference: { kind: "error", path: [] } };
      }
      if (
        !(ERROR_FIELDS as readonly string[]).includes(field) ||
        extra.length > 0
      ) {
        return fail(
          `"${text}" is not a valid error reference`,
          'Use "error", "error.name", "error.message" or "error.cause"',
        );
      }
      return { ok: true, reference: { kind: "error", path: [field] } };
    }
    case "nodes": {
      const [nodeId, source, ...path] = rest;
      if (nodeId === undefined || (source !== "result" && source !== "input")) {
        return fail(
          `"${text}" is not a valid node reference`,
          'Write "nodes.<id>.result[.path]" or "nodes.<id>.input[.path]"',
        );
      }
      return { ok: true, reference: { kind: "node", nodeId, source, path } };
    }
    case "workItem": {
      const [field, alias, ...path] = rest;
      if (field === "title" && alias === undefined) {
        return { ok: true, reference: { kind: "workItemTitle" } };
      }
      if (field === "description" && alias === undefined) {
        return { ok: true, reference: { kind: "workItemDescription" } };
      }
      if (field === "fields" && alias !== undefined) {
        return { ok: true, reference: { kind: "workItemField", alias, path } };
      }
      return fail(
        `"${text}" is not a valid work-item reference`,
        'Use "workItem.title", "workItem.description" or "workItem.fields.<alias>" with an alias declared in "workItemFields"',
      );
    }
    default:
      return fail(
        `"${text}" is not a reference. Write literals as { "value": ... }`,
        `References start with ${ROOTS.map((name) => `"${name}"`).join(", ")}. For a literal string write { "value": ${JSON.stringify(text)} }`,
      );
  }
}

export function formatReference(reference: Reference): string {
  switch (reference.kind) {
    case "node":
      return [
        "nodes",
        reference.nodeId,
        reference.source,
        ...reference.path,
      ].join(".");
    case "workItemTitle":
      return "workItem.title";
    case "workItemDescription":
      return "workItem.description";
    case "workItemField":
      return ["workItem", "fields", reference.alias, ...reference.path].join(
        ".",
      );
    default:
      return [reference.kind, ...reference.path].join(".");
  }
}
