import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import {
  TASK_MESSAGE_BODY_MAX_LENGTH,
  TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH,
} from "../domain/task-message-entity";

export const taskMessageSchema = z.object({
  id: uuidV7Schema,
  taskId: uuidV7Schema,
  authorUserId: uuidV7Schema,
  body: z.string().min(1).max(TASK_MESSAGE_BODY_MAX_LENGTH),
  quoteText: z
    .string()
    .min(1)
    .max(TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH)
    .nullable(),
  createdAt: z.iso.datetime(),
});

export const sendStepMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(TASK_MESSAGE_BODY_MAX_LENGTH),
  quoteText: z
    .string()
    .trim()
    .min(1)
    .max(TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH)
    .optional(),
});

export type TaskMessageContract = z.infer<typeof taskMessageSchema>;
export type SendStepMessageBody = z.input<typeof sendStepMessageBodySchema>;
