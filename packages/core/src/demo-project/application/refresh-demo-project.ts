import { sql } from "drizzle-orm";
import type { AppContext } from "@scarn/core/lib/di";
import { getDb } from "@scarn/core/lib/db";
import { resetDemoExecutions } from "./reset-demo-executions";
import {
  seedDemoProject,
  type SeedDemoProjectResult,
} from "./seed-demo-project";
import { DEMO_ACCOUNT_USERNAME, DEMO_PROJECT_SLUG } from "../demo-account";

/**
 * A fixed, arbitrarily-chosen key unique to this job. `pg_try_advisory_xact_lock`
 * only needs a stable `bigint` that nothing else in the repo happens to use —
 * there is no registry of advisory-lock keys to collide with, so any
 * distinctive constant is fine.
 */
export const DEMO_PROJECT_REFRESH_LOCK_KEY = 872_341_001;

/**
 * Composes the two existing, already-idempotent demo-project functions —
 * `resetDemoExecutions` then `seedDemoProject` — with no new domain logic of
 * its own, so a caller can get a demo project with entirely fresh executions
 * (new tasks, new fabricated logs/artifacts) in one call.
 *
 * Deliberately does not call `assertConsistentSeedEnvironment`
 * (`apps/api/src/seed-environment-guard.ts`): that guard only exists to catch
 * a local developer's mismatched `DATABASE_URL`/`S3_*` shell exports before
 * they seed against the wrong environment. In a deployed route,
 * `AppContext` is already wired consistently by the process's own
 * configuration, so the guard's check is meaningless there.
 *
 * Guarded by a Postgres advisory lock (`DEMO_PROJECT_REFRESH_LOCK_KEY`)
 * because two concurrent refreshes racing — a manual trigger firing during
 * the scheduled window, say, or a retry landing while the first attempt is
 * still running — would otherwise both try to delete/recreate the same
 * singleton demo project's rows at once and could hit unique-constraint
 * errors mid-flight. The lock makes an overlapping invocation short-circuit
 * to a no-op (returning the demo project's fixed, well-known path) rather
 * than racing the in-progress one.
 *
 * The lock is acquired via `pg_try_advisory_xact_lock` inside a single
 * `getDb().transaction(...)` call, and `resetDemoExecutions`/`seedDemoProject`
 * run inside that same callback so the lock stays held for their entire
 * duration. Note, though, that this does NOT mean their DB work runs in one
 * transaction/connection — it doesn't: every repo call each of them makes
 * opens its own connection/transaction from the pool internally (see e.g.
 * `DrizzleOrgRepo`). Only the lock-acquisition wrapper is a single
 * transaction. That's intentional and safe specifically because Postgres
 * advisory locks are visible server-wide the moment they're held — not
 * connection-local — so any other session attempting the same key sees it
 * held and gets `false` back immediately, regardless of which pooled
 * connection either side is using. When this function's transaction commits
 * (or the callback returns), `_xact_lock`'s scoping releases the lock
 * automatically — no manual unlock needed.
 */
export const refreshDemoProject = async (
  appContext: AppContext,
): Promise<SeedDemoProjectResult> => {
  return await getDb().transaction(async (tx) => {
    const rows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${DEMO_PROJECT_REFRESH_LOCK_KEY}) AS locked`,
    );
    const locked = rows.rows[0]?.locked === true;

    if (!locked) {
      appContext.logger.warn(
        { lockKey: DEMO_PROJECT_REFRESH_LOCK_KEY },
        "refreshDemoProject: another refresh is already in progress, skipping this invocation",
      );
      return {
        projectPath: `/${DEMO_ACCOUNT_USERNAME}/${DEMO_PROJECT_SLUG}`,
      };
    }

    await resetDemoExecutions(appContext);
    return await seedDemoProject(appContext);
  });
};
