import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ArtifactKind } from "@scarn/core/tasks/task-artifact/contracts/task-artifact-contracts";
import type {
  FailNode,
  Next,
  SucceedNode,
  WaitNode,
} from "@scarn/sdk/contracts/pipeline-document";

/**
 * Shared types for the demo project's flagship pipeline — the one branching
 * pipeline whose branches every flagship work item replays a real captured
 * run of. See `triage-and-investigate-pipeline-fixture.ts` for the fixture
 * itself and `seed-demo-flagship-execution.ts` for the orchestration.
 *
 * Deliberately a fixture vocabulary rather than the document format: a fixture
 * lists its step nodes (whose `step` key is derived from the pipeline key) and
 * its wait and end nodes, and `ensureDemoFlagshipPipelineDefinition` assembles
 * the pipeline document from them.
 */

/**
 * One step node. `key` is its node id, unique across the whole pipeline, and
 * also the lookup key for a flagship's captured content (see
 * `DemoFlagshipStepContent`), so the same step key must never mean two
 * different things in two branches.
 */
export type DemoFlagshipStepNodeFixture = {
  key: string;
  stepName: string;
  stepPrompt: string;
  /** The first matching route wins; `otherwise` when none matches. */
  next: Next;
};

export type DemoFlagshipPipelineFixture = {
  key: string;
  name: string;
  description: string;
  entryNodeKey: string;
  steps: readonly DemoFlagshipStepNodeFixture[];
  /** Wait nodes, keyed by node id. */
  waitNodes: Readonly<Record<string, WaitNode>>;
  /** Terminal nodes the steps' transitions end on, keyed by node id. */
  endNodes: Readonly<Record<string, SucceedNode | FailNode>>;
};

export type DemoFlagshipStepArtifactFixture = {
  relativeStorePath: string;
  contentType: string;
  kind: ArtifactKind;
  bytes: Uint8Array;
};

export type DemoFlagshipStepContent = {
  /** Raw captured JSONL text (one `LogLineContract`-shaped line per line). */
  rawLogJsonl: string;
  resultJson: AnyJsonValue;
  artifacts?: readonly DemoFlagshipStepArtifactFixture[];
};

export type EnsureDemoFlagshipExecutionInput = {
  projectId: UuidV7;
  userAuthz: UserAuthorizationService;
  workItem: {
    platformKey: string;
    title: string;
    description: string;
    daysAgo: number;
  };
  /** Looked up by the node key of whichever step the run actually reached. */
  stepContent: (stepKey: string) => Promise<DemoFlagshipStepContent>;
};
