import z from "zod";
import { uuidV7Schema, type UuidV7 } from "./uuid-v7";

const startedByUserSchema = z.object({
  userId: uuidV7Schema,
  /** `null` when unresolved. */
  username: z.string().nullable(),
});

/**
 * Who started a pipeline run or Task: a person, an automation, an
 * automation's schedule rule, or `system` for one with none of them (seeded
 * data, or an automation since deleted).
 */
export const startedBySchema = z.discriminatedUnion("kind", [
  startedByUserSchema.extend({ kind: z.literal("user") }),
  z.object({
    kind: z.literal("automation"),
    automationId: uuidV7Schema,
    key: z.string(),
    title: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("schedule"),
    automationId: uuidV7Schema,
    key: z.string(),
    title: z.string().nullable(),
    schedule: z.object({
      id: uuidV7Schema,
      /** The rule key. */
      key: z.string(),
      /** The rule was removed from the automation since. */
      removed: z.boolean(),
    }),
    /** The person who ran it with Run now; `null` when the tick fired it. */
    user: startedByUserSchema.nullable(),
  }),
  z.object({ kind: z.literal("system") }),
]);

export type StartedByContract = z.infer<typeof startedBySchema>;

export type StartingAutomation = {
  id: UuidV7;
  key: string;
  title: string | null;
};

export type StartingSchedule = {
  id: UuidV7;
  key: string;
  removed: boolean;
};

/**
 * The schedule (with its automation, and the person for Run now) when there
 * is one, else the person, else the automation, else `system`.
 */
export const toStartedBy = (
  starter: {
    userId: UuidV7 | null;
    automation: StartingAutomation | null;
    schedule?: StartingSchedule | null | undefined;
  },
  usernamesByUserId: ReadonlyMap<UuidV7, { username: string | null }>,
): StartedByContract => {
  const { userId, automation, schedule } = starter;
  const user = userId
    ? {
        userId,
        username: usernamesByUserId.get(userId)?.username ?? null,
      }
    : null;
  if (schedule && automation) {
    return {
      kind: "schedule",
      automationId: automation.id,
      key: automation.key,
      title: automation.title,
      schedule,
      user,
    };
  }
  if (user) {
    return { kind: "user", ...user };
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
