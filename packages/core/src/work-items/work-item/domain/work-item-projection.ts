import { createHash } from "node:crypto";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { WorkItemEntity } from "./work-item-entity";

export type WorkItemProjectionFieldPath =
  | "platform"
  | "platformId"
  | "platformKey"
  | "url"
  | "title"
  | "description"
  | `fields.${string}`
  | "sourceCreatedAt"
  | "sourceUpdatedAt"
  | "createdAt"
  | "updatedAt";

export type WorkItemProjectionSpec = {
  id: string;
  fields: readonly WorkItemProjectionFieldPath[];
};

export type WorkItemProjection = {
  specId: string;
  values: Record<string, AnyJsonValue>;
  canonicalContent: string;
  fingerprint: string;
};

const normalizeText = (value: string): string =>
  value.replace(/\r\n/g, "\n").trim();

const normalizeValue = (value: AnyJsonValue): AnyJsonValue => {
  if (typeof value === "string") {
    return normalizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]);

    return Object.fromEntries(entries) as Record<string, AnyJsonValue>;
  }

  return value;
};

const canonicalize = (value: AnyJsonValue): string => JSON.stringify(normalizeValue(value));

const resolveProjectionField = (
  workItem: WorkItemEntity,
  field: WorkItemProjectionFieldPath,
): AnyJsonValue => {
  switch (field) {
    case "platform":
      return workItem.platform;
    case "platformId":
      return workItem.platformId;
    case "platformKey":
      return workItem.platformKey;
    case "url":
      return workItem.url;
    case "title":
      return workItem.title;
    case "description":
      return workItem.description;
    case "sourceCreatedAt":
      return workItem.sourceCreatedAt?.toISOString() ?? null;
    case "sourceUpdatedAt":
      return workItem.sourceUpdatedAt?.toISOString() ?? null;
    case "createdAt":
      return workItem.createdAt?.toISOString() ?? null;
    case "updatedAt":
      return workItem.updatedAt?.toISOString() ?? null;
    default: {
      if (field.startsWith("fields.")) {
        return workItem.fields[field.slice("fields.".length)] ?? null;
      }

      throw new InvariantViolationError(
        `Unsupported projection field: ${field}`,
        "UNSUPPORTED_WORK_ITEM_PROJECTION_FIELD",
      );
    }
  }
};

export const projectWorkItem = (
  workItem: WorkItemEntity,
  spec: WorkItemProjectionSpec,
): WorkItemProjection => {
  const values = Object.fromEntries(
    spec.fields.map((field) => [field, resolveProjectionField(workItem, field)]),
  );
  const canonicalContent = canonicalize({
    specId: spec.id,
    values,
  });
  const fingerprint = createHash("sha256")
    .update(canonicalContent, "utf8")
    .digest("hex");

  return {
    specId: spec.id,
    values,
    canonicalContent,
    fingerprint,
  };
};
