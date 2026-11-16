import type { Logger } from "@scarn/observability/logging/host";
import { DefaultLocalProjectRuntimeEnvironmentOrchestrator } from "../infra/local-project-runtime-environment";
import { buildLocalProjectRuntimeDeps } from "../infra/local-project-runtime-environment-deps";
import type { SafeProviderAccessResolver } from "../infra/provider-access/safe-provider-access-resolver";
import type { LaunchedRuntimeOrchestrator } from "../contracts/process-project-work-types";

/**
 * Build a host/container checkout orchestrator with a {@link SafeProviderAccessResolver}
 * substituted for the default `DirectProviderAccessResolver`, so a missing
 * provider credential is reported rather than aborting the launch. Uses the
 * same default deps as `DefaultLocalProjectRuntimeEnvironmentOrchestrator`
 * (including the shared git clone service factory), except for that swap and
 * no git credential relay: a dry run never hands out host credentials.
 */
export function buildDryRunOrchestrator(
  logger: Logger,
  localEnvVars: Record<string, string>,
  safeProviderAccessResolver: SafeProviderAccessResolver,
): LaunchedRuntimeOrchestrator {
  return new DefaultLocalProjectRuntimeEnvironmentOrchestrator(
    logger,
    buildLocalProjectRuntimeDeps(logger, localEnvVars, {
      providerAccessResolver: safeProviderAccessResolver,
      openGitCredentialRelaySession: null,
    }),
  );
}

/** A dry run has no claim and opens no relay, so nothing reads this. */
export const DRY_RUN_CLAIM_TOKEN = "dry-run";
