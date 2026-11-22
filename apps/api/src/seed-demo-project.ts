import { DefaultAppContext } from "@scarn/core/lib/di";
import { closeDb } from "@scarn/core/lib/db";
import { seedDemoProject } from "@scarn/core/demo-project/application/seed-demo-project";
import { resetDemoExecutions } from "@scarn/core/demo-project/application/reset-demo-executions";
import { assertConsistentSeedEnvironment } from "./seed-environment-guard";

assertConsistentSeedEnvironment();

const args = process.argv.slice(2);
const shouldReset = args.includes("--reset");

if (shouldReset) {
  console.warn(
    "[seed:demo-project] --reset: deleting existing demo work item executions...",
  );
  await resetDemoExecutions(DefaultAppContext);
  console.warn("[seed:demo-project] reset done — re-seeding...");
}

console.warn("[seed:demo-project] seeding the public demo project...");
const { projectPath } = await seedDemoProject(DefaultAppContext);
console.warn(
  `[seed:demo-project] done — demo project available at ${projectPath}`,
);
await closeDb();
