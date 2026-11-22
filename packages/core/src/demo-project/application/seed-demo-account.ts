import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@scarn/core/lib/di";
import { noopAnalytics } from "@scarn/core/lib/analytics/analytics-port";
import { createProject } from "@scarn/core/projects/project/application/create-project";
import {
  DEMO_ACCOUNT_NAME,
  DEMO_ACCOUNT_USER_ID,
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_NAME,
  DEMO_PROJECT_SLUG,
} from "../demo-account";

/**
 * Not a real repository — `example.com` is IANA-reserved for documentation
 * and never resolves, matching the convention used by other seeded/test
 * projects in this repo (see `status-ladder-test-support.ts`). The demo
 * project's pipelines never actually clone a workspace, so this value is only
 * ever schema-validated, never fetched.
 */
const DEMO_PROJECT_GIT_URL = "https://github.com/example/scarn-demo-project.git";

const DEMO_PROJECT_DESCRIPTION =
  "The public demo project every logged-out visitor and brand-new signup gets pointed at — real pipelines, real work items, and real (fictional-bug) executions, including one that failed.";

export type DemoAccountContext = {
  projectId: UuidV7;
  orgId: UuidV7;
  ownerUsername: string;
};

/**
 * Idempotently provisions the demo account's personal org and its singleton
 * public demo project.
 *
 * Idempotency: `orgRepo.createPersonalOrg` already returns the existing
 * personal org on repeat calls. The project itself is looked up by its fixed,
 * human-chosen `(orgId, slug)` pair first — `createProject` is a true insert
 * (fails on conflict), so re-running the seed script must short-circuit
 * before calling it a second time, exactly like every other "ensure" helper
 * in this seed (see `seed-demo-pipeline.ts`, `seed-demo-execution.ts`).
 */
export const ensureDemoAccountAndProject = async (
  appContext: AppContext,
): Promise<DemoAccountContext> => {
  const { projectRepo, orgRepo, timeProvider, domainEventDispatcher } =
    appContext;

  const org = await orgRepo.createPersonalOrg({
    ownerUserId: DEMO_ACCOUNT_USER_ID,
    ownerName: DEMO_ACCOUNT_NAME,
  });

  const existingProject = await projectRepo.loadByOrgAndSlug(
    org.id,
    DEMO_PROJECT_SLUG,
  );
  if (existingProject) {
    return {
      projectId: existingProject.id,
      orgId: org.id,
      ownerUsername: DEMO_ACCOUNT_USERNAME,
    };
  }

  const userAuthz = appContext.createUserAuthorizationService(
    DEMO_ACCOUNT_USER_ID,
  );
  const created = await createProject(
    {
      name: DEMO_PROJECT_NAME,
      description: DEMO_PROJECT_DESCRIPTION,
      gitUrl: DEMO_PROJECT_GIT_URL,
      source: "manual",
    },
    {
      userAuthz,
      projectRepo,
      orgRepo,
      timeProvider,
      domainEventDispatcher,
      analytics: noopAnalytics,
      // Internal-only: never reachable from the HTTP `createProjectInputSchema`.
      // This is the one line in the whole seed script that makes the project
      // public — see the comment on `ProjectEntity.visibility`.
      visibility: "public",
    },
  );

  return {
    projectId: parseUuidV7(created.id),
    orgId: org.id,
    ownerUsername: DEMO_ACCOUNT_USERNAME,
  };
};
