/**
 * Types reference strings at a use site: checks the reference is allowed
 * there, finds the JSON Schema it resolves to, and records `nodes.*`
 * reach-backs for {@link checkReachBacks}.
 */
import {
  ERROR_SCHEMA,
  jsonPointer,
  type JsonSchema,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  formatReference,
  parseReference,
  type ReferenceKind,
} from "../references/parse";
import {
  inputSchemaOf,
  report,
  resultSchemaOf,
  type Site,
  type ValidationContext,
} from "./context";
import type { Segment } from "./graph";
import {
  ANY,
  deref,
  isAnySchema,
  propertyNames,
  rooted,
  schemaAtPath,
  type RootedSchema,
} from "./json-schema";
import { describeSchema } from "./schema-relations";
import { closest, quoteList } from "./suggest";

const WORK_ITEM_TITLE_SCHEMA: JsonSchema = { type: "string" };
const WORK_ITEM_DESCRIPTION_SCHEMA: JsonSchema = { type: ["string", "null"] };

function describeBase(kind: string, owner: string | null): string {
  return owner === null ? kind : `"${owner}"'s ${kind}`;
}

function unknownPath(
  ctx: ValidationContext,
  site: Site,
  base: RootedSchema,
  path: readonly string[],
  text: string,
  baseText: string,
  ownerLabel: string,
  pointer: Segment[],
): void {
  let parent = base;
  let index = 0;
  for (; index < path.length; index += 1) {
    const next = schemaAtPath(parent, [path[index] as string]);
    if (next === null) {
      break;
    }
    parent = next;
  }
  const missing = path[index] ?? "";
  const options = propertyNames(parent);
  const suggestion = closest(missing, options);
  const prefix = [baseText, ...path.slice(0, index)].join(".");
  report(ctx, site, {
    code: "unknown_path",
    path: jsonPointer(pointer),
    message: `"${text}" doesn't exist: ${ownerLabel} (${describeSchema(base)}) has no "${[...path.slice(0, index + 1)].join(".")}"`,
    ...(suggestion !== undefined
      ? { hint: `Did you mean "${prefix}.${suggestion}"?` }
      : options.length > 0
        ? { hint: `"${prefix}" has ${quoteList(options)}` }
        : {}),
  });
}

const KIND_HINTS: Partial<Record<ReferenceKind, string>> = {
  result: '"result" is only available in "next" transitions',
  input: '"input" is only available in "next" and "catch"',
  item: '"item" is only available in the args of a transition with "each"',
  error: '"error" is only available in "catch"',
};

/**
 * The schema a reference string resolves to at a site, or null when the
 * reference is invalid there (an error is reported unless the site is silent).
 * `nodes.*` references are recorded for {@link checkReachBacks}.
 */
export function resolveReferenceSchema(
  ctx: ValidationContext,
  site: Site,
  text: string,
  pointer: Segment[],
): RootedSchema | null {
  const parsed = parseReference(text);
  if (!parsed.ok) {
    report(ctx, site, {
      code: "invalid_reference",
      path: jsonPointer(pointer),
      message: parsed.message,
      ...(parsed.hint === undefined ? {} : { hint: parsed.hint }),
    });
    return null;
  }
  const { reference } = parsed;
  if (!site.allowed.has(reference.kind)) {
    const where =
      site.kind === "start"
        ? "the start transition"
        : site.kind === "catch"
          ? "a catch"
          : "this transition";
    report(ctx, site, {
      code: "reference_not_allowed",
      path: jsonPointer(pointer),
      message: `"${text}" can't be used in ${where}`,
      hint:
        site.kind === "start"
          ? 'The start transition can only use "workItem.title", "workItem.description", "workItem.fields.<alias>" and { "value": ... }'
          : (KIND_HINTS[reference.kind] ??
            "Reach back with nodes.<id>.result or pass it along in args"),
    });
    return null;
  }
  const sourceLabel = site.sourceId;
  switch (reference.kind) {
    case "result":
    case "input": {
      const base =
        reference.kind === "result"
          ? resultSchemaOf(ctx, sourceLabel ?? "")
          : inputSchemaOf(ctx, sourceLabel ?? "");
      return checkedPath(
        ctx,
        site,
        base,
        reference.path,
        text,
        reference.kind,
        describeBase(reference.kind, sourceLabel),
        pointer,
      );
    }
    case "item":
      return checkedPath(
        ctx,
        site,
        site.item ?? ANY,
        reference.path,
        text,
        "item",
        "the list item",
        pointer,
      );
    case "error":
      return checkedPath(
        ctx,
        site,
        rooted(ERROR_SCHEMA),
        reference.path,
        text,
        "error",
        "error",
        pointer,
      );
    case "node": {
      if (site.silent !== true) {
        ctx.reachBacks.push({
          pointer: jsonPointer(pointer),
          sourceId: site.sourceId,
          site: site.kind,
          nodeId: reference.nodeId,
          source: reference.source,
          useScope: site.useScope,
        });
      }
      const target = ctx.document.nodes[reference.nodeId];
      if (
        target === undefined ||
        target.kind === "succeed" ||
        target.kind === "fail"
      ) {
        return null;
      }
      const base =
        reference.source === "result"
          ? resultSchemaOf(ctx, reference.nodeId)
          : inputSchemaOf(ctx, reference.nodeId);
      const baseText = `nodes.${reference.nodeId}.${reference.source}`;
      return checkedPath(
        ctx,
        site,
        base,
        reference.path,
        text,
        baseText,
        describeBase(reference.source, reference.nodeId),
        pointer,
      );
    }
    case "workItemTitle":
      return rooted(WORK_ITEM_TITLE_SCHEMA);
    case "workItemDescription":
      return rooted(WORK_ITEM_DESCRIPTION_SCHEMA);
    case "workItemField": {
      const aliases = Object.keys(ctx.document.workItemFields ?? {});
      if (!aliases.includes(reference.alias)) {
        const suggestion = closest(reference.alias, aliases);
        report(ctx, site, {
          code: "unknown_path",
          path: jsonPointer(pointer),
          message: `"${formatReference(reference)}" uses an alias that isn't declared in "workItemFields"`,
          hint:
            suggestion === undefined
              ? `Add "${reference.alias}" to "workItemFields", mapping it to the form label`
              : `Did you mean "workItem.fields.${suggestion}"?`,
        });
        return null;
      }
      return ANY;
    }
  }
}

function checkedPath(
  ctx: ValidationContext,
  site: Site,
  base: RootedSchema,
  path: readonly string[],
  text: string,
  baseText: string,
  ownerLabel: string,
  pointer: Segment[],
): RootedSchema | null {
  const found = schemaAtPath(base, path);
  if (found === null) {
    unknownPath(ctx, site, base, path, text, baseText, ownerLabel, pointer);
    return null;
  }
  return isAnySchema(found) ? ANY : { ...found, schema: deref(found).schema };
}
