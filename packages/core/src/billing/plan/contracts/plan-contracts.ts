import { z } from "zod";

export const planIdSchema = z.enum(["free", "unlimited"]);

export type PlanId = z.infer<typeof planIdSchema>;
