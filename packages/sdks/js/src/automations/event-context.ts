/**
 * The `r` a rule's callbacks receive: placeholders over what the rule's
 * event carries, compiled to `event.*` refs.
 */
import {
  eventHasChild,
  type AutomationEvent,
  type AutomationSubject,
} from "../contracts/automation-document";
import type { JsonSchema } from "../contracts/pipeline-document";
import { rootPlaceholder } from "../pipelines/refs";
import { markSubject } from "./targets";

const PROPERTY_SCHEMAS: Record<string, JsonSchema | undefined> = {
  title: { type: "string" },
  description: { type: ["string", "null"] },
  fields: undefined,
  labels: { type: "array", items: { type: "string" } },
  state: { type: "string", enum: ["open", "closed"] },
};

const SCHEDULE_SCHEMAS: Record<string, JsonSchema> = {
  key: { type: "string" },
  scheduledFor: { type: "string", format: "date-time" },
  previousScheduledFor: { type: ["string", "null"], format: "date-time" },
  timezone: { type: "string" },
};

function placeholders(
  prefix: string,
  schemas: Record<string, JsonSchema | undefined>,
  owner: object,
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [property, schema] of Object.entries(schemas)) {
    Object.defineProperty(value, property, {
      get: () => rootPlaceholder(`${prefix}.${property}`, schema, { owner }),
      enumerable: true,
    });
  }
  return value;
}

function eventWorkItem(subject: AutomationSubject, owner: object): object {
  return markSubject(
    placeholders(`event.${subject}`, PROPERTY_SCHEMAS, owner),
    subject,
  );
}

/** The `r` for a rule's callbacks: placeholders over what the event carries. */
export function eventContext(event: AutomationEvent): object {
  const context: Record<string, unknown> = {};
  if (event === "schedule") {
    context["schedule"] = placeholders(
      "event.schedule",
      SCHEDULE_SCHEMAS,
      context,
    );
    return context;
  }
  context["workItem"] = eventWorkItem("workItem", context);
  if (eventHasChild(event)) {
    context["child"] = eventWorkItem("child", context);
  }
  if (event === "workItem.label.added") {
    Object.defineProperty(context, "label", {
      get: () =>
        rootPlaceholder("event.label", { type: "string" }, { owner: context }),
      enumerable: true,
    });
  }
  return context;
}
