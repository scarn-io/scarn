import { z } from "zod";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { createTolerantReader } from "@scarn/core/lib/db/stored-json";
import type { StoredArtifactMarkerOutcome } from "../domain/comment-artifact-types";

/**
 * Read-side schema for `notification_deliveries.artifact_resolution_json`.
 * Tolerant, not versioned: it is a delivery record, read for display and
 * for retry only.
 *
 * The column is null or the object `buildArtifactResolutionJson` writes:
 * `markers`, `leftOut` and `warnings` (the per-marker resolution, shown in
 * the draft review UI) and `outcomes` (what each marker became on the
 * platform, reused when an approval is retried).
 *
 * - {@link readStoredArtifactResolutionJson} reads the column as any JSON
 *   object, which the delivery carries and writes back.
 * - {@link readStoredArtifactResolution} reads the display sections; a
 *   document that doesn't fit is unreadable and the draft shows no
 *   resolution.
 * - {@link readStoredArtifactMarkerOutcomes} reads `outcomes`, skipping
 *   entries that don't fit. `platform` is any string, so an outcome for a
 *   platform this code no longer knows is kept; renderers only reuse
 *   outcomes for their own platform.
 *
 * A marker that resolved to an artifact bundle stores the bundle id as
 * `artifact.artifactId`, its name as `name` and `kind: "bundle"`; older
 * records only ever hold files, so no version bump was needed.
 *
 * Structural only and frozen here: no SDK enums. See
 * `docs/persistence/json-columns.md`.
 */

const storedArtifactResolutionJsonSchema = z
  .record(z.string(), z.json())
  .nullable();

const storedRefSchema = z.union([
  z.object({
    type: z.literal("signal"),
    stepKey: z.string(),
    signalKey: z.string(),
  }),
  z.object({ type: z.literal("path"), pattern: z.string() }),
]);

const storedMarkerSchema = z.object({
  markerIndex: z.number(),
  kind: z.string(),
  ref: storedRefSchema,
  caption: z.string(),
  standalone: z.boolean(),
  status: z.enum(["resolved", "unavailable"]),
  required: z.boolean(),
  reason: z.string().nullable(),
  artifact: z
    .object({
      artifactId: z.string(),
      name: z.string(),
      contentType: z.string().nullable(),
      kind: z.string(),
      sizeBytes: z.number().nullable(),
    })
    .nullable(),
});

const storedLeftOutSchema = z.object({
  markerIndex: z.number(),
  ref: storedRefSchema,
  caption: z.string(),
  reason: z.string(),
});

const storedWarningSchema = z.object({
  markerIndex: z.number(),
  code: z.string(),
  message: z.string(),
});

const storedArtifactResolutionSchema = z.object({
  markers: z.array(storedMarkerSchema),
  leftOut: z.array(storedLeftOutSchema),
  warnings: z.array(storedWarningSchema),
});

const storedOutcomeSchema = z.object({
  markerIndex: z.number(),
  artifactId: z.string(),
  platform: z.string(),
  outcome: z.enum(["embedded", "linked"]),
  externalRef: z.string().nullable(),
});

/** The display sections of a delivery's artifact resolution. */
export type StoredArtifactResolution = z.infer<
  typeof storedArtifactResolutionSchema
>;

/** Reads the column as a JSON object or null, or explains why it is unreadable. */
export const readStoredArtifactResolutionJson =
  createTolerantReader<AnyJsonObject | null>(
    storedArtifactResolutionJsonSchema,
  );

/** Reads the display sections of a stored resolution, or explains why they are unreadable. */
export const readStoredArtifactResolution = createTolerantReader<
  StoredArtifactResolution,
  AnyJsonObject
>(storedArtifactResolutionSchema);

/** The per-marker outcomes stored on a delivery, skipping malformed entries. */
export const readStoredArtifactMarkerOutcomes = (
  json: AnyJsonObject | null,
): StoredArtifactMarkerOutcome[] => {
  const outcomes = json?.["outcomes"];
  if (!Array.isArray(outcomes)) return [];
  return outcomes.flatMap((entry) => {
    const parsed = storedOutcomeSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
};
