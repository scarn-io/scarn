import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { purgeAbandonedTaskLogs } from "@scarn/core/tasks/task-log/application/purge-abandoned-task-logs";
import { sweepDeletedStorage } from "@scarn/core/tasks/storage-sweep/application/sweep-deleted-storage";
import { createServiceAuthenticated } from "./service-authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const purgeAbandonedLogsResultSchema = z.object({
  stepsPurged: z.number().int().nonnegative(),
  linesPurged: z.number().int().nonnegative(),
});

const sweepDeletedStorageResultSchema = z.object({
  swept: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
});

// Machine-to-machine maintenance trigger that cleans up the live log feed for
// tasks that reached the terminal `abandoned` status. Abandoned tasks
// never run the completion path, so their hot `task_log_lines` rows
// are otherwise orphaned forever. Abandoned logs are intentionally NOT archived
// to object storage — they are simply dropped from Postgres. Invoked on a
// schedule by AWS EventBridge (see infra/purge-abandoned-logs-schedule.tf),
// authenticated with a shared bearer token via `createServiceAuthenticated`
// (NOT a user session). The use case is idempotent, so a missed or duplicate
// invocation is harmless.
//
// `sweep-deleted-storage` is the delayed second pass of the deletion contract
// (docs/adr/0003-conversation-deletion-contract.md): it deletes the stored
// objects of deleted runs once their pre-issued upload URLs have expired.
// Scheduled by infra/sweep-deleted-storage-schedule.tf.
export const createExecutionsMaintenanceRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createServiceAuthenticated())
    .post(
      "/internal/executions/purge-abandoned-logs",
      {
        response: responseSchemas({
          200: purgeAbandonedLogsResultSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "purgeAbandonedTaskLogs",
          tags: ["TaskRuns"],
        },
      },
      async () =>
        await purgeAbandonedTaskLogs({
          logFeedStore: appContext.logFeedStore,
          timeProvider: appContext.timeProvider,
          logger: appContext.logger,
        }),
    )
    .post(
      "/internal/executions/sweep-deleted-storage",
      {
        response: responseSchemas({
          200: sweepDeletedStorageResultSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "sweepDeletedStorage",
          tags: ["TaskRuns"],
        },
      },
      async () =>
        await sweepDeletedStorage({
          storageSweepRepo: appContext.storageSweepRepo,
          objectStore: appContext.objectStore,
          timeProvider: appContext.timeProvider,
          logger: appContext.logger,
        }),
    );
