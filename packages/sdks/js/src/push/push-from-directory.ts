import {
  AutomationsApiError,
  createAutomationsClient,
} from "../definitions/automations";
import {
  createPipelineDefinitionsClient,
  PipelineDefinitionsApiError,
} from "../definitions/pipelines";
import { createStepDefinitionsClient } from "../definitions/steps";
import { assertValidDefinitionSpecs } from "../definitions/validation";
import { z } from "zod";
import { collectDefinitionsFromDirectory } from "./collect-definitions";
import {
  collectBuiltDocuments,
  type PipelineDocumentFile,
} from "./collect-pipeline-documents";

export interface PushFromDirectoryOptions {
  baseUrl: string;
  projectId: string;
  accessToken: string;
  /** Override the logger; defaults to console.log. */
  log?: (message: string) => void;
}

export interface PushFromDirectoryResult {
  pushedSteps: number;
  /** Keys of the pipelines that got a new active version. */
  publishedPipelines: string[];
  /** Keys of the pipelines whose document matched their latest version. */
  unchangedPipelines: string[];
  /** Keys of the automations that got a new version. */
  publishedAutomations: string[];
  /** Keys of the automations whose document matched their latest version. */
  unchangedAutomations: string[];
}

type PipelinesClient = ReturnType<typeof createPipelineDefinitionsClient>;
type AutomationsClient = ReturnType<typeof createAutomationsClient>;
type Headers = { Authorization: string };

const latestVersionSchema = z.object({ version: z.number() });

/**
 * Pushes a pipeline-builder directory to the server, in three passes:
 *
 * 1. Upserts every step exported from the `.ts`/`.js` files (except the push
 *    script itself).
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
  const headers = { Authorization: `Bearer ${opts.accessToken}` };

  const { steps } = await collectDefinitionsFromDirectory(dir);
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
    `Found ${String(steps.length)} step(s), ${String(documents.length)} pipeline document(s) and ${String(automations.length)} automation document(s).`,
  );

  assertValidDefinitionSpecs(steps);

  const stepsClient = createStepDefinitionsClient(opts.baseUrl);
  for (const spec of steps) {
    await stepsClient.upsertFromSpec(opts.projectId, spec, { headers });
    log(`✓ step ${spec.key} v${String(spec.version)} → upserted`);
  }

  const pipelinesClient = createPipelineDefinitionsClient(opts.baseUrl);
  const publishedPipelines: string[] = [];
  const unchangedPipelines: string[] = [];
  if (documents.length > 0) {
    const serverPipelines = await pipelinesClient.listByProjectId(
      opts.projectId,
      { headers },
    );
    const idByKey = new Map(serverPipelines.map((p) => [p.key, p.id]));
    for (const document of documents) {
      const published = await publishPipelineDocument(
        document,
        idByKey.get(document.key),
        opts.projectId,
        headers,
        pipelinesClient,
        log,
      );
      (published ? publishedPipelines : unchangedPipelines).push(document.key);
    }
  }

  const automationsClient = createAutomationsClient(opts.baseUrl);
  const publishedAutomations: string[] = [];
  const unchangedAutomations: string[] = [];
  for (const document of automations) {
    const published = await publishAutomationDocument(
      document,
      opts.projectId,
      headers,
      automationsClient,
      log,
    );
    (published ? publishedAutomations : unchangedAutomations).push(
      document.key,
    );
  }

  return {
    pushedSteps: steps.length,
    publishedPipelines,
    unchangedPipelines,
    publishedAutomations,
    unchangedAutomations,
  };
}

/** Returns false when the document matched the pipeline's latest version. */
async function publishPipelineDocument(
  { file, key, title, document }: PipelineDocumentFile,
  pipelineDefinitionId: string | undefined,
  projectId: string,
  headers: Headers,
  pipelinesClient: PipelinesClient,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    if (pipelineDefinitionId === undefined) {
      await pipelinesClient.create(
        { projectId, key, name: title ?? key, document },
        { headers },
      );
      log(`✓ pipeline ${key} → created and published (${file})`);
      return true;
    }
    const result = await pipelinesClient.publishVersion(
      pipelineDefinitionId,
      document,
      { headers },
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
  headers: Headers,
  automationsClient: AutomationsClient,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    const result = await automationsClient.publish(projectId, key, document, {
      headers,
    });
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
