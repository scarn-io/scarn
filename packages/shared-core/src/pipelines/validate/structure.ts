/**
 * Structural checks: the zod parse (mapped to pointer errors) and the
 * features that are in the format but rejected in v1.
 */
import type { z } from "zod";
import {
  jsonPointer,
  pipelineDocumentSchema,
  routeEntries,
  type PipelineDocument,
} from "@scarn/sdk/contracts/pipeline-document";
import type { ValidationError } from "./types";

const NOT_IN_V1_HINT = "This is part of the format but not supported in v1";

function describeIssue(issue: z.core.$ZodIssue): {
  message: string;
  hint?: string;
} {
  switch (issue.code) {
    case "unrecognized_keys":
      return {
        message: `Unknown ${issue.keys.length === 1 ? "key" : "keys"} ${issue.keys.map((key) => `"${key}"`).join(", ")}`,
        hint: "Remove it, or check the spelling",
      };
    case "invalid_union": {
      const last = issue.path[issue.path.length - 2];
      if (last === "args") {
        return {
          message:
            'An arg must be a reference string, { "value": ... } or { "list": [...] }',
          hint: 'Write literals as { "value": ... }',
        };
      }
      if (issue.path.at(-1) === "toleratedFailures") {
        return {
          message:
            'Write "toleratedFailures" as { "count": n } or { "percent": n }',
        };
      }
      if (
        issue.path.length >= 2 &&
        issue.path[0] === "nodes" &&
        issue.path.length === 2
      ) {
        return {
          message: 'A node needs "kind": "step", "wait", "succeed" or "fail"',
        };
      }
      return { message: issue.message };
    }
    default:
      return { message: issue.message };
  }
}

export function parseDocument(
  // eslint-disable-next-line local/no-unknown-parameter-type -- parses an untrusted document at the boundary
  input: unknown,
):
  | { ok: true; document: PipelineDocument }
  | { ok: false; errors: ValidationError[] } {
  const parsed = pipelineDocumentSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, document: parsed.data };
  }
  const errors = parsed.error.issues.map((issue): ValidationError => {
    const segments = issue.path.map((segment) =>
      typeof segment === "number" ? segment : String(segment),
    );
    const { message, hint } = describeIssue(issue);
    return {
      code: "schema",
      path: jsonPointer(segments),
      message,
      ...(hint === undefined ? {} : { hint }),
    };
  });
  return { ok: false, errors };
}

/**
 * A `decision` wait needs at least one action, with unique keys; no other
 * wait may have `actions`.
 */
export function checkDecisionActions(
  document: PipelineDocument,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.kind !== "wait") {
      continue;
    }
    if (node.for !== "decision") {
      if (node.actions !== undefined) {
        errors.push({
          code: "schema",
          path: jsonPointer(["nodes", id, "actions"]),
          message: `"actions" is only allowed on a "decision" wait, not a "${node.for}" wait`,
          hint: 'Remove "actions", or make the wait "for": "decision"',
        });
      }
      continue;
    }
    if (node.actions === undefined || node.actions.length === 0) {
      errors.push({
        code: "schema",
        path: jsonPointer(["nodes", id, "actions"]),
        message: `decision wait "${id}" needs at least one action`,
        hint: 'Add "actions": [{ "key": "approve", "label": "Approve" }, ...]',
      });
      continue;
    }
    const seen = new Set<string>();
    node.actions.forEach((action, index) => {
      if (seen.has(action.key)) {
        errors.push({
          code: "schema",
          path: jsonPointer(["nodes", id, "actions", index, "key"]),
          message: `decision wait "${id}" has more than one action "${action.key}"`,
          hint: "Give each action a unique key",
        });
      }
      seen.add(action.key);
    });
  }
  return errors;
}

/** Rejects retry delays, wait and pipeline timeouts, event/timer waits and routing to another pipeline. */
export function checkNotInV1(document: PipelineDocument): ValidationError[] {
  const errors: ValidationError[] = [];
  const push = (
    segments: (string | number)[],
    message: string,
    hint = NOT_IN_V1_HINT,
  ) => {
    errors.push({
      code: "not_in_v1",
      path: jsonPointer(segments),
      message,
      hint,
    });
  };
  if (document.timeoutSeconds !== undefined) {
    push(
      ["timeoutSeconds"],
      "A pipeline-level timeoutSeconds is not supported in v1",
      `${NOT_IN_V1_HINT}; remove it. Step nodes can still set timeoutSeconds`,
    );
  }
  if (document.start.pipeline !== undefined) {
    push(["start", "pipeline"], "Routing to another pipeline is not supported");
  }
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.kind === "wait") {
      if (node.for !== "decision" && node.for !== "reply") {
        push(
          ["nodes", id, "for"],
          `wait "for": "${node.for}" is not supported in v1`,
          `${NOT_IN_V1_HINT}; only "decision" and "reply" waits are supported`,
        );
      }
      if (node.timeoutSeconds !== undefined) {
        push(
          ["nodes", id, "timeoutSeconds"],
          "timeoutSeconds on a wait node is not supported in v1",
          `${NOT_IN_V1_HINT}; remove it`,
        );
      }
    }
    if (node.kind !== "step" && node.kind !== "wait") {
      continue;
    }
    for (const entry of routeEntries(node.next)) {
      if (entry.route.pipeline !== undefined) {
        push(
          ["nodes", id, "next", ...entry.pointer, "pipeline"],
          "Routing to another pipeline is not supported",
          "Sub-pipelines will be a separate design",
        );
      }
    }
    (node.catch ?? []).forEach((entry, index) => {
      if (entry.pipeline !== undefined) {
        push(
          ["nodes", id, "catch", index, "pipeline"],
          "Routing to another pipeline is not supported",
          "Sub-pipelines will be a separate design",
        );
      }
    });
    if (node.kind !== "step") {
      continue;
    }
    (node.retry ?? []).forEach((retry, index) => {
      for (const key of [
        "intervalSeconds",
        "backoffRate",
        "maxDelaySeconds",
      ] as const) {
        if (retry[key] !== undefined) {
          push(
            ["nodes", id, "retry", index, key],
            `Retry "${key}" is not supported in v1`,
            `${NOT_IN_V1_HINT}; retries are claimable immediately. Remove it`,
          );
        }
      }
    });
  }
  return errors;
}
