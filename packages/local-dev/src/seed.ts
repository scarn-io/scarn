/**
 * Puts the `acme-sandbox` project on the local stack into a known state.
 * See docs/plans/local-dev.md for the full flow.
 */
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { closeDb } from "@scarn/core/lib/db";
import { DefaultAppContext } from "@scarn/core/lib/di";
import { grantLocalDevAdmin } from "@scarn/core/local-dev/application/grant-local-dev-admin";
import { resetLocalDevProject } from "@scarn/core/local-dev/application/reset-local-dev-project";
import { preflight, resolveAuth } from "./auth";
import {
  BASE_URL,
  DEV_LOGIN_EMAIL,
  PROJECT_NAME,
  PROJECT_SECRETS,
  ROOT_DIR,
  TEMPLATE_REF,
  TEMPLATE_REPO_URL,
} from "./config";
import { runCliChecked } from "./cli";
import { assertLocalEnvironment } from "./guard";
import { ensureProject } from "./project";
import { commitAndPush, rebuildRepos, repoPaths } from "./repo";
import { seedSecrets } from "./secrets";
import { seedWorkItems, type SeededWorkItem } from "./seed-work-items";
import { WORK_ITEMS } from "./work-items";

function log(message: string): void {
  process.stdout.write(`[local-dev] ${message}\n`);
}

async function main(): Promise<void> {
  assertLocalEnvironment(BASE_URL);
  await preflight(BASE_URL);

  const auth = await resolveAuth(BASE_URL, DEV_LOGIN_EMAIL);
  log(
    `signed in to ${auth.origin} as ${auth.user.username ?? "?"} <${auth.user.email}> (${auth.source})`,
  );

  const project = await ensureProject({
    auth,
    name: PROJECT_NAME,
    gitUrl: repoPaths(ROOT_DIR).bare,
  });
  log(
    `${project.created ? "created" : "reusing"} project ${project.ref} (${project.id})`,
  );

  await grantLocalDevAdmin(
    DefaultAppContext,
    parseUuidV7(project.id),
    parseUuidV7(auth.user.id),
  );
  log(`granted ${auth.user.email} admin on ${project.ref}`);

  await seedSecrets({ auth, projectId: project.id, secrets: PROJECT_SECRETS });
  log(
    `saved project secrets ${PROJECT_SECRETS.map((secret) => secret.name).join(", ")}`,
  );

  const reset = await resetLocalDevProject(
    DefaultAppContext,
    parseUuidV7(project.id),
  );
  log(
    `reset ${String(reset.workItems)} work items, ${String(reset.tasks)} tasks, ${String(reset.notifications)} notifications`,
  );

  const paths = await rebuildRepos({
    rootDir: ROOT_DIR,
    templateUrl: TEMPLATE_REPO_URL,
    templateRef: TEMPLATE_REF,
    projectRef: project.ref,
  });
  log(`rebuilt ${paths.bare} and ${paths.checkout}`);

  await runCliChecked(["pipelines", "build"], paths.checkout);
  await commitAndPush(paths.checkout, TEMPLATE_REF);
  log(`committed and pushed ${paths.checkout}`);

  await runCliChecked(["pipelines", "push"], paths.checkout);
  log("pushed steps, pipelines and the default automation");

  await runCliChecked(["automations", "enable", "default"], paths.checkout);
  log("enabled the default automation");

  const seeded = await seedWorkItems({
    auth,
    projectId: project.id,
    items: WORK_ITEMS,
  });
  log(`upserted ${String(seeded.length)} work items`);

  printSummary(new URL(`/${project.ref}`, BASE_URL).toString(), seeded);
}

function printSummary(projectUrl: string, seeded: SeededWorkItem[]): void {
  const header = ["key", "pipeline", "expect", "work item id"];
  const body = seeded.map(({ item, id, pipeline }) => [
    item.key,
    pipeline ?? "—",
    item.expect,
    id,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((row) => row[column]?.length ?? 0)),
  );
  const format = (row: string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");

  const lines = [
    "",
    `Project: ${projectUrl}`,
    "",
    format(header),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...body.map(format),
    "",
    "Run the worker: bun run --filter @scarn/local-dev work",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

try {
  await main();
} finally {
  await closeDb();
}
