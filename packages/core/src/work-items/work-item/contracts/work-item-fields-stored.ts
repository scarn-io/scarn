import { z } from "zod";
import { createTolerantReader } from "@scarn/core/lib/db/stored-json";
import type { WorkItemFields } from "../domain/work-item-field-value";

/**
 * Read-side schema for `work_items.fields`. Tolerant, not versioned: the
 * keys come from the source system's form (GitHub, Bitbucket and Jira
 * ingest, Jira custom fields, or whatever a client posted), not from a shape
 * this code owns.
 *
 * The column is a JSON object of field name to any JSON value. It is read
 * in SQL as `fields ->> key` by the listing filters and the field options
 * query (`work-item-listing-query.ts`), which only match scalar values, so
 * a value of any JSON type reads here. Anything other than an object is
 * unreadable; the repo logs it and reads the work item with no fields.
 *
 * Structural only and frozen here. See `docs/persistence/json-columns.md`.
 */
const storedWorkItemFieldValueSchema = z.json();

const storedWorkItemFieldsSchema = z.record(
  z.string(),
  storedWorkItemFieldValueSchema,
);

/** Reads a work item's `fields` column, or explains why it is unreadable. */
export const readStoredWorkItemFields = createTolerantReader<WorkItemFields>(
  storedWorkItemFieldsSchema,
);
