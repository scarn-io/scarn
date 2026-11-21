import type { FetchLike } from "../auth";
import {
  AutomationsApiError,
  createAutomationsClient,
} from "../definitions/automations";
import {
  createPipelineDefinitionsClient,
  PipelineDefinitionsApiError,
} from "../definitions/pipelines";
import {
  createEnvironmentsClient,
  EnvironmentsApiError,
  type EnvironmentsClient,
} from "../definitions/environments/environments-client";
import { createStepDefinitionsClient } from "../definitions/steps";
import type { StepDefinitionSpec } from "../definitions/steps";
import { assertValidDefinitionSpecs } from "../definitions/validation";
import { z } from "zod";
import {
  collectDefinitionsFromDirectory,
  type CollectedEnvironment,
} from "./collect-definitions";
import {
  collectBuiltDocuments,
  type PipelineDocumentFile,
} from "./collect-pipeline-documents";
import { pushedMcpServers, type PushedMcpServer } from "./pushed-mcp-servers";

export interface PushFromDirectoryOptions {
  baseUrl: string;
  projectId: string;
  /**
   * Authenticates every request, e.g. the `fetch` from `loadPushDefaults` or
   * one from `createAuthenticatedFetch`.
   */
  fetch: FetchLike;
  /** Override the logger; defaults to console.log. */
  log?: (message: string) => void;
}

export interface PushFromDirectoryResult {
  /** Names of the environments that got a new version. */
  publishedEnvironments: string[];
  /** Names of the environments whose content matched their latest version. */
  unchangedEnvironments: string[];
  pushedSteps: number;
  /** Keys of the pipelines that got a new active version. */
  publishedPipelines: string[];
  /** Keys of the pipelines whose document matched their latest version. */
  unchangedPipelines: string[];
  /** Keys of the automations that got a new version. */
  publishedAutomations: string[];
  /** Keys of the automations whose document matched their latest version. */
  unchangedAutomations: string[];
  /** Every enabled `ref` and `remote` MCP server of the pushed steps. */
  mcpServers: PushedMcpServer[];
}

type PipelinesClient = ReturnType<typeof createPipelineDefinitionsClient>;
type AutomationsClient = ReturnType<typeof createAutomationsClient>;

const latestVersionSchema = z.object({ version: z.number() });

/**
 * Pushes a pipeline-builder directory to the server, in four passes:
 *
 * 0. Publishes every environment collected from the `.ts`/`.js` files: each
 *    exported `defineEnvironment` handle and each handle a collected step
 *    uses. Content matching the latest version publishes nothing.
 * 1. Upserts every step exported from the `.ts`/`.js` files (except the push
 *    script itself) and every local step their pipelines use. A step naming an environment by string that isn't
 *    collected must already exist on the server; that's checked with one
 *    list call before anything is uploaded.
 * 2. Publishes every built pipeline document (`<key>.json`, from
 *    `scarn pipelines build`), creating the pipeline when its key is new.
 *    The server pins each document to the steps just pushed; a document
 *    identical to its latest version publishes nothing.
 * 3. Publishes every built automation document (`<key>.json` with
 *    `kind: "automation"`). Work-item automations go first, since a project
 *    automation's `attach` targets must already exist. A new automation starts
 *    disabled; deleting a source file unpublishes nothing.
 *
 * Collection (`collectDefinitionsFromDirectory`, `collectBuiltDocuments`)
 * and step validation (`validateDefinitionSpecs`) are offline and run before
 * the first mutating request, so an invalid batch fails without half-pushing.
 *
 * Designed to run on the user's native runtime (bun, node-with-tsx, deno),
 * NOT inside a `bun --compile`'d binary — that runtime can't resolve scoped
 * package `exports` field remappings from external user files.
 */
export async function pushFromDirectory(
  dir: string,
  opts: PushFromDirectoryOptions,
): Promise<PushFromDirectoryResult> {
  const log =
    opts.log ??
    ((msg: string) => {
      console.warn(msg);
    });
  const clientOptions = { fetch: opts.fetch };

  const { steps, environments } = await collectDefinitionsFromDirectory(dir);
  const built = collectBuiltDocuments(dir);
  const documents = built.filter((file) => file.kind === "pipeline");
  const automations = built
    .filter((file) => file.kind === "automation")
    .sort(
      (a, b) =>
        Number(a.document["scope"] === "project") -
        Number(b.document["scope"] === "project"),
    );

  log(
    `Found ${String(environments.length)} environment(s), ${String(steps.length)} step(s), ${String(documents.length)} pipeline document(s) and ${String(automations.length)} automation document(s).`,
  );

  assertValidDefinitionSpecs(steps);

  const environmentsClient = createEnvironmentsClient(
    opts.baseUrl,
    clientOptions,
  );
  await assertNamedEnvironmentsExist(
    steps,
    environments,
    opts.projectId,
    environmentsClient,
  );

  const publishedEnvironments: string[] = [];
  const unchangedEnvironments: string[] = [];
  for (const environment of environments) {
    const published = await publishEnvironment(
      environment,
      opts.projectId,
      environmentsClient,
      log,
    );
    (published ? publishedEnvironments : unchangedEnvironments).push(
      environment.name,
    );
  }

  const stepsClient = createStepDefinitionsClient(opts.baseUrl, clientOptions);
  for (const spec of steps) {
    await stepsClient.upsertFromSpec(opts.projectId, spec);
    log(`✓ step ${spec.key} v${String(spec.version)} → upserted`);
  }

  const pipelinesClient = createPipelineDefinitionsClient(
    opts.baseUrl,
    clientOptions,
  );
  const publishedPipelines: string[] = [];
  const unchangedPipelines: string[] = [];
  if (documents.length > 0) {
    const serverPipelines = await pipelinesClient.listByProjectId(
      opts.projectId,
    );
    const idByKey = new Map(serverPipelines.map((p) => [p.key, p.id]));
    for (const document of documents) {
      const published = await publishPipelineDocument(
        document,
        idByKey.get(document.key),
        opts.projectId,
        pipelinesClient,
        log,
      );
      (published ? publishedPipelines : unchangedPipelines).push(document.key);
    }
  }

  const automationsClient = createAutomationsClient(
    opts.baseUrl,
    clientOptions,
  );
  const publishedAutomations: string[] = [];
  const unchangedAutomations: string[] = [];
  for (const document of automations) {
    const published = await publishAutomationDocument(
      document,
      opts.projectId,
      automationsClient,
      log,
    );
    (published ? publishedAutomations : unchangedAutomations).push(
      document.key,
    );
  }

  return {
    publishedEnvironments,
    unchangedEnvironments,
    pushedSteps: steps.length,
    publishedPipelines,
    unchangedPipelines,
    publishedAutomations,
    unchangedAutomations,
    mcpServers: pushedMcpServers(steps),
  };
}

/**
 * Fails before any upload when a step names an environment by string that is
 * neither collected locally nor on the server. Lists the server's
 * environments only when some name isn't collected.
 */
async function assertNamedEnvironmentsExist(
  steps: readonly StepDefinitionSpec[],
  environments: readonly CollectedEnvironment[],
  projectId: string,
  environmentsClient: EnvironmentsClient,
): Promise<void> {
  const local = new Set(environments.map((environment) => environment.name));
  const stepsByMissingName = new Map<string, string[]>();
  for (const step of steps) {
    if (step.environment?.kind !== "named") continue;
    const name = step.environment.name;
    if (local.has(name)) continue;
    stepsByMissingName.set(name, [
      ...(stepsByMissingName.get(name) ?? []),
      step.key,
    ]);
  }
  if (stepsByMissingName.size === 0) return;

  const onServer = new Set(
    (await environmentsClient.listByProjectId(projectId)).map(
      (environment) => environment.name,
    ),
  );
  const unknown = [...stepsByMissingName].filter(
    ([name]) => !onServer.has(name),
  );
  if (unknown.length === 0) return;
  throw new Error(
    [
      "Steps name environments that aren't defined locally or on the server:",
      ...unknown.map(
        ([name, keys]) =>
          `  "${name}" (used by ${[...new Set(keys)].join(", ")})`,
      ),
      "Define them with defineEnvironment in the pipeline-builder directory, then push again. Nothing was uploaded.",
    ].join("\n"),
  );
}

/** Returns false when the content matched the environment's latest version. */
async function publishEnvironment(
  { name, content, sourceFile }: CollectedEnvironment,
  projectId: string,
  environmentsClient: EnvironmentsClient,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    const result = await environmentsClient.publish(projectId, name, content);
    const version = String(result.version.version);
    log(
      result.published
        ? `✓ environment ${name} v${version} → published (${sourceFile})`
        : `✓ environment ${name} v${version} → unchanged (${sourceFile})`,
    );
    return result.published;
  } catch (error) {
    if (!(error instanceof EnvironmentsApiError)) throw error;
    const issues = error.issues.map(
      (issue) => `  ${issue.path || "/"}: ${issue.message}`,
    );
    throw new Error(
      [
        `Could not publish environment "${name}" (${sourceFile}): ${error.message}`,
        ...issues,
      ].join("\n"),
      { cause: error },
    );
  }
}

/** Returns false when the document matched the pipeline's latest version. */
async function publishPipelineDocument(
  { file, key, title, document }: PipelineDocumentFile,
  pipelineDefinitionId: string | undefined,
  projectId: string,
  pipelinesClient: PipelinesClient,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    if (pipelineDefinitionId === undefined) {
      await pipelinesClient.create({
        projectId,
        key,
        name: title ?? key,
        document,
      });
      log(`✓ pipeline ${key} → created and published (${file})`);
      return true;
    }
    const result = await pipelinesClient.publishVersion(
      pipelineDefinitionId,
      document,
    );
    const version = String(result.version.version);
    log(
      result.published
        ? `✓ pipeline ${key} v${version} → published (${file})`
        : `✓ pipeline ${key} v${version} → unchanged (${file})`,
    );
    return result.published;
  } catch (error) {
    rethrowPublishError(file, error);
  }
}

/** Returns false when the document matched the automation's latest version. */
async function publishAutomationDocument(
  { file, key, document }: PipelineDocumentFile,
  projectId: string,
  automationsClient: AutomationsClient,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    const result = await automationsClient.publish(projectId, key, document);
    const latest = latestVersionSchema.safeParse(
      result.automation.latestVersion,
    );
    const version = latest.success ? ` v${String(latest.data.version)}` : "";
    log(
      result.published
        ? `✓ automation ${key}${version} → published (${file})`
        : `✓ automation ${key}${version} → unchanged (${file})`,
    );
    return result.published;
  } catch (error) {
    rethrowPublishError(file, error);
  }
}

/** Rethrows an API rejection naming the file, with each document issue on its own line. */
function rethrowPublishError(
  file: string,
  // eslint-disable-next-line local/no-unknown-parameter-type -- a caught error
  error: unknown,
): never {
  if (
    !(error instanceof PipelineDefinitionsApiError) &&
    !(error instanceof AutomationsApiError)
  ) {
    throw error;
  }
  const issues = error.issues.map((issue) =>
    issue.hint === undefined
      ? `  ${issue.path || "/"}: ${issue.message}`
      : `  ${issue.path || "/"}: ${issue.message}. ${issue.hint}`,
  );
  throw new Error(
    [`Could not publish ${file}: ${error.message}`, ...issues].join("\n"),
    { cause: error },
  );
}
