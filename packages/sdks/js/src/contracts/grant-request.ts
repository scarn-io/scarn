/**
 * The grants an agent asks for before it hands over (`.scarn/grant-request.json`).
 * The opencode plugin's `scarn-request-access` tool writes it; the worker
 * sends it as the yield's `grantRequest` and deletes it. `grantSchema` mirrors
 * the server's write rules for one work item grant.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Grant } from "../definitions/steps/step-features";

export const GRANT_REQUEST_RELATIVE_PATH = ".scarn/grant-request.json";

const labelsSchema = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(50)
  .refine((labels) => new Set(labels).size === labels.length, {
    message: "Grant labels must be unique",
  });

const resource = z.literal("workItem");
const changeScope = z.enum(["self", "children"]);
const keyPrefix = z.string().min(1).max(200).optional();

/** One work item grant, as the server accepts it. */
export const grantSchema = z.discriminatedUnion("action", [
  z.object({
    resource,
    action: z.literal("read"),
    scope: z.enum(["self", "children", "project"]),
  }),
  z.discriminatedUnion("scope", [
    z.object({ resource, action: z.literal("update"), scope: changeScope }),
    z.object({
      resource,
      action: z.literal("update"),
      scope: z.literal("project"),
      keyPrefix,
      labels: labelsSchema.optional(),
    }),
  ]),
  z.object({ resource, action: z.literal("comment"), scope: changeScope }),
  z.object({
    resource,
    action: z.literal("label"),
    scope: changeScope,
    labels: labelsSchema,
  }),
  z.object({ resource, action: z.literal("block"), scope: changeScope }),
  z.object({ resource, action: z.literal("close"), scope: changeScope }),
  z.discriminatedUnion("scope", [
    z.object({
      resource,
      action: z.literal("create"),
      scope: z.literal("children"),
      labels: labelsSchema,
    }),
    z.object({
      resource,
      action: z.literal("create"),
      scope: z.literal("project"),
      labels: labelsSchema,
      keyPrefix,
    }),
  ]),
]) satisfies z.ZodType<Grant>;

/** What the yield's `grantRequest` carries. */
export const grantRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  grants: z.array(grantSchema).min(1).max(20),
});

export type GrantRequest = { reason: string; grants: Grant[] };

export function buildGrantRequestPath(workspacePath: string): string {
  return path.join(workspacePath, GRANT_REQUEST_RELATIVE_PATH);
}

/** The recorded request, or null when there is none. Throws when malformed. */
export async function readGrantRequest(
  workspacePath: string,
): Promise<GrantRequest | null> {
  let raw: string;
  try {
    raw = await readFile(buildGrantRequestPath(workspacePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const parsed = grantRequestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${GRANT_REQUEST_RELATIVE_PATH} is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Deletes the file: after it is sent, and when a run's workspace is set up. */
export async function removeGrantRequest(workspacePath: string): Promise<void> {
  await rm(buildGrantRequestPath(workspacePath), { force: true });
}
