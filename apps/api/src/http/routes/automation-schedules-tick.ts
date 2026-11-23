import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { tickAutomationSchedules } from "@scarn/core/pipeline-definitions/automation/application/tick-automation-schedules";
import { createServiceAuthenticated } from "./service-authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const tickAutomationSchedulesResultSchema = z.object({
  fired: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  collapsed: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
});

/**
 * Machine-to-machine cron tick for automation `schedule` rules
 * (docs/plans/automation-schedules.md). AWS EventBridge calls it every minute
 * (see infra/automation-schedule-tick-schedule.tf), authenticated with a
 * shared bearer token via `createServiceAuthenticated` against the dedicated
 * `AUTOMATION_SCHEDULE_TICK_CRON_SECRET`.
 *
 * It fires every due schedule of an enabled project automation, up to a batch
 * limit. A schedule that fails to start is recorded on the schedule and
 * counted in `errored`; the response is 200 unless the whole tick fails.
 */
export const createAutomationSchedulesTickRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createServiceAuthenticated("AUTOMATION_SCHEDULE_TICK_CRON_SECRET"))
    .post(
      "/internal/automations/schedules/tick",
      {
        response: responseSchemas({
          200: tickAutomationSchedulesResultSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "tickAutomationSchedules",
          tags: ["Automations"],
        },
      },
      async () => await tickAutomationSchedules(appContext),
    );
