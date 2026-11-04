/**
 * Types the `event.*` references an automation rule reads in `when` and
 * `args`: `event.workItem.<prop>`, `event.child.<prop>` (only on `child.*`
 * events) and `event.label` (only on `workItem.label.added`), where `<prop>`
 * is `title`, `description`, `labels`, `state` or `fields.<name>`.
 *
 * Work item fields are free-form, so `fields.<name>` (and anything below it)
 * types as "any": a field ref passes every type check.
 */
import {
  eventHasChild,
  type AutomationEvent,
} from "@scarn/sdk/contracts/automation-document";
import {
  jsonPointer,
  type JsonSchema,
} from "@scarn/sdk/contracts/pipeline-document";
import { splitPath } from "../pipelines/references/parse";
import type { ReportContext, Site } from "../pipelines/validate/context";
import { report } from "../pipelines/validate/context";
import type { Segment } from "../pipelines/validate/graph";
import {
  ANY,
  rooted,
  schemaAtPath,
  type RootedSchema,
} from "../pipelines/validate/json-schema";
import { closest, quoteList } from "../pipelines/validate/suggest";

const WORK_ITEM_PROPS: Readonly<Record<string, JsonSchema>> = {
  title: { type: "string" },
  description: { type: ["string", "null"] },
  labels: { type: "array", items: { type: "string" } },
  state: { type: "string", enum: ["open", "closed"] },
};

const PROP_NAMES = [...Object.keys(WORK_ITEM_PROPS), "fields"];

/** A site for a rule's refs. Automations have no graph, so only the event matters. */
export function eventSite(): Site {
  return {
    sourceId: null,
    kind: "route",
    allowed: new Set(),
    useScope: [],
  };
}

function rootsOf(event: AutomationEvent): string[] {
  return [
    "event.workItem",
    ...(eventHasChild(event) ? ["event.child"] : []),
    ...(event === "workItem.label.added" ? ["event.label"] : []),
  ];
}

function workItemProp(
  ctx: ReportContext,
  site: Site,
  text: string,
  base: string,
  rest: readonly string[],
  pointer: Segment[],
): RootedSchema | null {
  const [prop, ...path] = rest;
  if (prop === "fields") {
    if (path.length === 0) {
      report(ctx, site, {
        code: "invalid_reference",
        path: jsonPointer(pointer),
        message: `"${text}" needs a field name`,
        hint: `Write "${base}.fields.<name>"`,
      });
      return null;
    }
    return ANY;
  }
  const schema = prop === undefined ? undefined : WORK_ITEM_PROPS[prop];
  if (prop === undefined || schema === undefined) {
    const suggestion =
      prop === undefined ? undefined : closest(prop, PROP_NAMES);
    report(ctx, site, {
      code: "unknown_path",
      path: jsonPointer(pointer),
      message:
        prop === undefined
          ? `"${text}" needs a property`
          : `"${text}" doesn't exist: a work item has no "${prop}"`,
      hint:
        suggestion === undefined
          ? `A work item has ${quoteList(PROP_NAMES)}`
          : `Did you mean "${base}.${suggestion}"?`,
    });
    return null;
  }
  const found = schemaAtPath(rooted(schema), path);
  if (found === null) {
    report(ctx, site, {
      code: "unknown_path",
      path: jsonPointer(pointer),
      message: `"${text}" doesn't exist: "${base}.${prop}" has no "${path.join(".")}"`,
    });
  }
  return found;
}

/** The schema an `event.*` reference resolves to on `event`, or null (and an error) when it's not valid there. */
export function resolveEventReference(
  ctx: ReportContext,
  site: Site,
  event: AutomationEvent,
  text: string,
  pointer: Segment[],
): RootedSchema | null {
  const segments = splitPath(text);
  const roots = rootsOf(event);
  if (segments === null || segments[0] !== "event") {
    report(ctx, site, {
      code: "invalid_reference",
      path: jsonPointer(pointer),
      message: `"${text}" is not a valid automation reference`,
      hint: `References read the event: ${quoteList(roots)}. Write literals as { "value": ... }`,
    });
    return null;
  }
  const [, subject, ...rest] = segments;
  const allowed = (root: string) => roots.includes(root);
  if (subject === "workItem" || subject === "child") {
    if (!allowed(`event.${subject}`)) {
      report(ctx, site, {
        code: "reference_not_allowed",
        path: jsonPointer(pointer),
        message: `"${text}" can't be used on "${event}"`,
        hint: '"event.child" only exists on child.* events',
      });
      return null;
    }
    return workItemProp(ctx, site, text, `event.${subject}`, rest, pointer);
  }
  if (subject === "label") {
    if (!allowed("event.label")) {
      report(ctx, site, {
        code: "reference_not_allowed",
        path: jsonPointer(pointer),
        message: `"${text}" can't be used on "${event}"`,
        hint: '"event.label" only exists on "workItem.label.added"',
      });
      return null;
    }
    const found = schemaAtPath(rooted({ type: "string" }), rest);
    if (found === null) {
      report(ctx, site, {
        code: "unknown_path",
        path: jsonPointer(pointer),
        message: `"${text}" doesn't exist: "event.label" is a string`,
      });
    }
    return found;
  }
  const suggestion =
    subject === undefined
      ? undefined
      : closest(
          subject,
          roots.map((root) => root.slice("event.".length)),
        );
  report(ctx, site, {
    code: "unknown_path",
    path: jsonPointer(pointer),
    message: `"${text}" doesn't exist on "${event}"`,
    hint:
      suggestion === undefined
        ? `The event has ${quoteList(roots)}`
        : `Did you mean "event.${suggestion}"?`,
  });
  return null;
}
