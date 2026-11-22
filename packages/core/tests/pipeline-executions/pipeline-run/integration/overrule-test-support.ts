import type { ProjectRole } from "@/projects/project/domain/project-role";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { RecordingAnalytics } from "@/lib/analytics/recording-analytics";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { unwrapAsync } from "tests/utils";
import { createPipelineRunHarness } from "./pipeline-run-test-support";

export type RouteSelectorBody =
  | { kind: "route"; index: number }
  | { kind: "otherwise" }
  | { to: string }
  | { label: string };

export type OverruleBody = {
  routes: RouteSelectorBody[];
  reason: string;
  acceptMissing?: boolean;
  preview?: boolean;
};

/**
 * A pipeline-run harness with recorded analytics, plus the documents and
 * calls the overrule tests make. `check` takes `fix` when its result says
 * so and otherwise fails the run at `rejected`; its routes are overridable
 * unless `overridable: "fix"` marks only the `fix` route.
 */
export const createOverruleHarness = (name: string) => {
  const analytics = new RecordingAnalytics();
  const harness = createPipelineRunHarness(name, { analytics });
  const headers = () => harness.requireSetup().headers;

  const checkDocument = ({
    overridable = "next",
    fixStep,
  }: {
    overridable?: "next" | "fix";
    fixStep?: string;
  } = {}): PipelineDocument => {
    const { stepKey } = harness.requireSetup();
    const marked = overridable === "fix" ? { overridable: true as const } : {};
    return {
      schemaVersion: 1,
      key: harness.uniqueKey("overrule"),
      start: { to: "check" },
      nodes: {
        check: {
          kind: "step",
          step: stepKey,
          next: {
            ...(overridable === "next" ? { overridable: true as const } : {}),
            routes: [
              {
                label: "Fix",
                when: { path: "result.broken", op: "equal", value: true },
                to: "fix",
                args: { note: "result.note" },
                ...marked,
              },
              {
                label: "Fix again",
                when: { path: "result.flaky", op: "equal", value: true },
                to: "fix",
              },
            ],
            otherwise: { label: "Reject", to: "rejected" },
          },
        },
        fix: {
          kind: "step",
          step: fixStep ?? stepKey,
          next: { routes: [{ to: "done" }] },
        },
        done: { kind: "succeed" },
        rejected: { kind: "fail", error: "Rejected" },
      },
    };
  };

  /** `pick` fans out to `left` and/or `right` side by side, both overridable. */
  const forkDocument = (): PipelineDocument => {
    const { stepKey } = harness.requireSetup();
    return {
      schemaVersion: 1,
      key: harness.uniqueKey("overrule-fork"),
      start: { to: "pick" },
      nodes: {
        pick: {
          kind: "step",
          step: stepKey,
          next: {
            match: "all",
            overridable: true,
            routes: [
              {
                when: { path: "result.left", op: "equal", value: true },
                to: "left",
              },
              {
                when: { path: "result.right", op: "equal", value: true },
                to: "right",
              },
            ],
          },
        },
        left: { kind: "step", step: stepKey },
        right: { kind: "step", step: stepKey },
      },
    };
  };

  /** Starts a `checkDocument` run and lets `check` succeed onto `rejected`. */
  const startRejectedRun = async (
    options: Parameters<typeof checkDocument>[0] = {},
    result: Record<string, string | boolean> = { note: "Retry the import" },
  ) => {
    const { executionId, workItemId } = await harness.startRun(
      checkDocument(options),
    );
    await harness.complete(await harness.claimOne(workItemId), "succeeded", {
      broken: false,
      flaky: false,
      ...result,
    });
    const run = await harness.getRun(executionId);
    return {
      executionId,
      workItemId,
      run,
      check: harness.visitOf(run, "check"),
    };
  };

  const overrule = async (
    executionId: UuidV7,
    visitId: UuidV7,
    body: OverruleBody,
    as: { authorization: string } = headers(),
  ) =>
    await harness
      .visitRoutes(executionId, visitId)
      .route.post(body, { headers: as });

  /** A second project member holding only `permissions`. */
  const memberWith = async (role: ProjectRole) => {
    const member = await createTestUserAndSession({
      email: `overrule-member-${crypto.randomUUID()}@example.com`,
    });
    await unwrapAsync(
      harness.apiClient.api
        .projects({ projectId: harness.requireSetup().projectId })
        .members({ userId: member.userId })
        .role.put({ role }, { headers: headers() }),
    );
    return { ...member.authHeaders };
  };

  /** A code step definition in the harness project; returns its key. */
  const createCodeStep = async () =>
    (
      await unwrapAsync(
        harness.apiClient.api["step-definitions"].put(
          {
            projectId: harness.requireSetup().projectId,
            key: `code-${crypto.randomUUID().slice(0, 8)}`,
            name: "Code step",
            kind: "code",
            version: 1,
            description: null,
            entrypointJson: { sourceFile: ".scarn/steps/fix.ts" },
            inputSchemaJson: { type: "object" },
            resultSchemaJson: { type: "object" },
            status: "active",
          } as never,
          { headers: headers() },
        ),
      )
    ).key;

  return {
    analytics,
    harness,
    headers,
    checkDocument,
    forkDocument,
    startRejectedRun,
    overrule,
    memberWith,
    createCodeStep,
  };
};
