import z from "zod";
import { uuidV7Schema, type UuidV7 } from "./uuid-v7";

/**
 * Who started a pipeline run or Task: a person, an automation, or `system`
 * for one with neither (seeded data, or an automation since deleted).
 */
export const startedBySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    userId: uuidV7Schema,
    /** `null` when unresolved. */
    username: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("automation"),
    automationId: uuidV7Schema,
    key: z.string(),
    title: z.string().nullable(),
  }),
  z.object({ kind: z.literal("system") }),
]);

export type StartedByContract = z.infer<typeof startedBySchema>;

export type StartingAutomation = {
  id: UuidV7;
  key: string;
  title: string | null;
};

/** The person when there is one, else the automation, else `system`. */
export const toStartedBy = (
  userId: UuidV7 | null,
  automation: StartingAutomation | null,
  usernamesByUserId: ReadonlyMap<UuidV7, { username: string | null }>,
): StartedByContract => {
  if (userId) {
    return {
      kind: "user",
      userId,
      username: usernamesByUserId.get(userId)?.username ?? null,
    };
  }
  if (automation) {
    return {
      kind: "automation",
      automationId: automation.id,
      key: automation.key,
      title: automation.title,
    };
  }
  return { kind: "system" };
};
