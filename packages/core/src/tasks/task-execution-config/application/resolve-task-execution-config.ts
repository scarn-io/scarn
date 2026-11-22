import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  type ResolveTaskExecutionConfigInput,
  resolveTaskExecutionConfigInputSchema,
} from "../contracts/task-execution-config-contracts";
import { TaskExecutionConfigEntity } from "../domain/task-execution-config-entity";
import { storedEnvironmentFromRef } from "../domain/task-execution-config-runtime";
import type { TaskExecutionConfigRepo } from "./task-execution-config-repo";

export type ResolveTaskExecutionConfigDeps = {
  taskExecutionConfigRepo: TaskExecutionConfigRepo;
};

/**
 * Turns a step definition's environment and independent overrides into a task
 * execution config row. Returns `null` when nothing overrides the repo's
 * config (D3); otherwise finds the project's row with the same content or
 * inserts one (D7).
 */
export const resolveTaskExecutionConfig = async (
  input: ResolveTaskExecutionConfigInput,
  { taskExecutionConfigRepo }: ResolveTaskExecutionConfigDeps,
  dbExecutor?: DbExecutor,
): Promise<TaskExecutionConfigEntity | null> => {
  const parsedInput = resolveTaskExecutionConfigInputSchema.parse(input);

  const config = TaskExecutionConfigEntity.create({
    projectId: parsedInput.projectId,
    content: {
      environment: storedEnvironmentFromRef(parsedInput.environment ?? null),
      git: parsedInput.repo ?? null,
      mcp: parsedInput.opencodeMcpJson ?? null,
      healthChecks: parsedInput.healthChecksJson ?? null,
    },
  });

  if (config.isEmpty()) return null;

  return await taskExecutionConfigRepo.findOrCreate(
    config,
    dbExecutor ?? getDb(),
  );
};
