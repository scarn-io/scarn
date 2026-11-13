/**
 * The version a background worker advertises in `worker.json` and
 * `/health`, and the CLI compares against its own. It is the CLI's
 * `package.json` version; a dev build appends `+dev.<buildId>` so a rebuilt
 * `scarn-dev` counts as a different version. Running from source has no
 * build ID, so it is just the package version.
 */
import { CONTROL_API_PROTOCOL } from "@scarn/worker";
import { version as packageVersion } from "../../package.json";
import { bakedCliBuildId } from "./build-constants";

export { CONTROL_API_PROTOCOL };

export function resolveWorkerVersion(
  input: { version?: string; buildId?: string | undefined } = {},
): string {
  const version = input.version ?? packageVersion;
  const buildId = "buildId" in input ? input.buildId : bakedCliBuildId();
  return buildId ? `${version}+dev.${buildId}` : version;
}
