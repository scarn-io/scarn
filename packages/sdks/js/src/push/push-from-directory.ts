import {
  createPipelineDefinitionsClient,
  PipelineDefinitionsApiError,
} from "../definitions/pipelines";
import {
  DEFAULT_PIPELINE_ASSIGNMENT_FILENAME,
  serializeDefaultPipelineAssignment,
  type DefaultPipelineAssignmentSpec,
} from "../definitions/pipelines/define-default-pipeline-assignment";
import { createStepDefinitionsClient } from "../definitions/steps";
import { assertValidDefinitionSpecs } from "../definitions/validation";
import { createClient } from "../generated/client";
import { Projects } from "../generated/sdk.gen";
import { collectDefinitionsFromDirectory } from "./collect-definitions";
import {
  collectPipelineDocuments,
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
  /** true if the default pipeline assignment was synced to the server. */
  syncedDefaultPipelineAssignment: boolean;
}

type PipelinesClient = ReturnType<typeof createPipelineDefinitionsClient>;
type Headers = { Authorization: string };

/**
 * Pushes a pipeline-builder directory to the server, in three passes:
 *
 * 1. Upserts every step exported from the `.ts`/`.js` files (except the push
 *    script itself and `default-pipeline-assignment.ts`).
 * 2. Publishes every built pipeline document (`<key>.json`, from
 *    `scarn pipelines build`), creating the pipeline when its key is new.
 *    The server pins each document to the steps just pushed; a document
 *    identical to its latest version publishes nothing.
 * 3. Syncs `default-pipeline-assignment.ts`, when present, as the project
 *    default pipeline assignment. Every pipeline it assigns must exist by now.
 *
 * Collection (`collectDefinitionsFromDirectory`, `collectPipelineDocuments`)
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

  const collected = await collectDefinitionsFromDirectory(dir);
  const { steps } = collected;
  const documents = collectPipelineDocuments(dir);

  log(
    `Found ${String(steps.length)} step(s) and ${String(documents.length)} pipeline document(s).`,
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

  const syncedDefaultPipelineAssignment = collected.defaultPipelineAssignment
    ? await syncDefaultPipelineAssignment(
        collected.defaultPipelineAssignment,
        opts,
        headers,
        pipelinesClient,
        log,
      )
    : false;

  return {
    pushedSteps: steps.length,
    publishedPipelines,
    unchangedPipelines,
    syncedDefaultPipelineAssignment,
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
    if (error instanceof PipelineDefinitionsApiError) {
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
    throw error;
  }
}

async function syncDefaultPipelineAssignment(
  spec: DefaultPipelineAssignmentSpec,
  opts: PushFromDirectoryOptions,
  headers: Headers,
  pipelinesClient: PipelinesClient,
  log: (msg: string) => void,
): Promise<boolean> {
  const serialized = serializeDefaultPipelineAssignment(spec);

  // Fetch all server pipelines to resolve pipeline key → pipelineDefinitionId
  const serverPipelines = await pipelinesClient.listByProjectId(
    opts.projectId,
    {
      headers,
    },
  );

  // Build key → id map from all referenced pipeline keys (assign outcomes)
  const pipelineKeyToId = new Map<string, string>(
    serverPipelines.map((p) => [p.key, p.id]),
  );

  // Collect all pipeline keys referenced in the spec (assign outcomes)
  const referencedKeys = new Set<string>();
  referencedKeys.add(serialized.pipelineDefinitionKey);
  for (const rule of serialized.rulesJson.rules) {
    if (
      rule.event.type === "assign" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      referencedKeys.add(rule.event.params["pipelineKey"]);
    }
  }

  // Validate all referenced pipeline keys exist on the server
  for (const key of referencedKeys) {
    if (!pipelineKeyToId.has(key)) {
      throw new Error(
        `${DEFAULT_PIPELINE_ASSIGNMENT_FILENAME} references pipeline "${key}", ` +
          `but no pipeline with that key was found on the server. ` +
          `Run \`scarn pipelines build\` to write ${key}.json next to its source, then push again.`,
      );
    }
  }

  // Resolve the primary pipelineDefinitionId
  const pipelineDefinitionId = pipelineKeyToId.get(
    serialized.pipelineDefinitionKey,
  );
  if (!pipelineDefinitionId) {
    throw new Error(
      `Pipeline key "${serialized.pipelineDefinitionKey}" was not found on the server.`,
    );
  }

  // Rewrite assign event params: replace pipelineKey → pipelineDefinitionId
  const resolvedRules = serialized.rulesJson.rules.map((rule) => {
    if (
      rule.event.type === "assign" &&
      typeof rule.event.params?.["pipelineKey"] === "string"
    ) {
      const pKey = rule.event.params["pipelineKey"];
      const pId = pipelineKeyToId.get(pKey);
      if (!pId) {
        throw new Error(
          `${DEFAULT_PIPELINE_ASSIGNMENT_FILENAME} assign() references pipeline "${pKey}" ` +
            `which was not found on the server.`,
        );
      }
      return {
        ...rule,
        event: {
          ...rule.event,
          params: {
            ...rule.event.params,
            pipelineDefinitionId: pId,
          },
        },
      };
    }
    return rule;
  });

  // Call the server API
  const projectsClient = new Projects({
    client: createClient({ baseUrl: opts.baseUrl }),
  });

  const result = await projectsClient.updateProjectDefaultPipelineAssignment({
    path: { projectId: opts.projectId },
    body: {
      defaultPipelineAssignment: {
        pipelineDefinitionId,
        rulesJson: { rules: resolvedRules },
        defaultEventType: serialized.defaultEventType,
        defaultEventParamsJson: serialized.defaultEventParamsJson,
        allowedEventTypes: serialized.allowedEventTypes,
      },
    },
    headers,
  });

  if (result.error) {
    throw new Error(
      `Failed to update project default pipeline assignment: ${JSON.stringify(result.error)}`,
    );
  }

  log(
    `✓ default pipeline assignment → synced (primary pipeline: ${serialized.pipelineDefinitionKey})`,
  );
  return true;
}
