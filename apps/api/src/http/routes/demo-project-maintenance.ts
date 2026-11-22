import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { refreshDemoProject } from "@scarn/core/demo-project/application/refresh-demo-project";
import { createServiceAuthenticated } from "./service-authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const demoProjectRefreshResultSchema = z.object({ projectPath: z.string() });

/**
 * Machine-to-machine maintenance trigger that resets and reseeds the
 * singleton public demo project (see `seedDemoProject`'s doc comment),
 * giving it entirely fresh tasks on every invocation. Invoked on a
 * schedule by AWS EventBridge (see
 * infra/demo-project-refresh-schedule.tf), authenticated with a shared
 * bearer token via `createServiceAuthenticated` against the dedicated
 * `DEMO_PROJECT_REFRESH_CRON_SECRET` (NOT `RECONCILE_CRON_SECRET`, and NOT a
 * user session) — there is no user actor for a background job, and unlike
 * the lower-stakes read/reconcile jobs above, this one hard-deletes and
 * recreates the demo project's pipeline executions, so its secret is
 * isolated from the others for independent rotation/disabling.
 *
 * `refreshDemoProject` composes two already-idempotent functions, so a
 * missed or duplicate scheduled invocation is not harmful by itself; a true
 * concurrent overlap (two invocations racing) is out of scope here and is
 * handled by a locking mechanism added separately.
 */
export const createDemoProjectMaintenanceRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createServiceAuthenticated("DEMO_PROJECT_REFRESH_CRON_SECRET"))
    .post(
      "/internal/demo-project/refresh",
      {
        response: responseSchemas({
          200: demoProjectRefreshResultSchema,
          ...stdErrors,
        }),
        detail: { operationId: "refreshDemoProject", tags: ["DemoProject"] },
      },
      async () => await refreshDemoProject(appContext),
    );
