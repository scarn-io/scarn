import { eq, inArray, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "./index";
import { projects } from "./schema";

/**
 * Limits a query on a project-owned table to the projects of one org: a
 * condition on `projectIdColumn`, or undefined (no limit) when `orgId` is
 * undefined, which `and(...)` ignores.
 */
export const projectInOrg = (
  projectIdColumn: AnyPgColumn,
  orgId: UuidV7 | undefined,
): SQL | undefined =>
  orgId === undefined
    ? undefined
    : inArray(
        projectIdColumn,
        getDb()
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.orgId, orgId)),
      );
