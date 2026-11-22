import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  pipelineGraphs,
  pipelineGraphVersions,
  pipelineGraphVersionSteps,
  projects,
  stepDefinitions,
  taskExecutionConfigs,
} from "@/lib/db/schema";
import { DrizzlePipelineGraphRepo } from "@/pipeline-definitions/pipeline-graph/infra/drizzle-pipeline-graph-repo";
import { DrizzleStepDefinitionRepo } from "@/pipeline-definitions/step-definition/infra/drizzle-step-definition-repo";

const createProject = async () => {
  const id = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id,
      name: "Managed connection usage",
      slug: `usage-${id}`,
      gitUrl: "https://github.com/example/usage.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return id;
};

const createConfig = async (
  projectId: UuidV7,
  mcpJson: Record<string, object> | null,
) => {
  const id = createUuidV7();
  await getDb().insert(taskExecutionConfigs).values({
    id,
    projectId,
    schemaVersion: 1,
    contentHash: id,
    mcpJson,
  });
  return id;
};

const createStep = async (
  projectId: UuidV7,
  key: string,
  taskExecutionConfigId: UuidV7 | null,
  version = 1,
  status: "active" | "draft" | "archived" = "active",
) => {
  const id = createUuidV7();
  await getDb()
    .insert(stepDefinitions)
    .values({
      id,
      projectId,
      key,
      name: `Step ${key} v${String(version)}`,
      version,
      status,
      taskExecutionConfigId,
      kind: "user_defined",
      prompt: "Use MCP",
      inputSchemaJson: { type: "object" },
      resultSchemaJson: { type: "object" },
    });
  return id;
};

const remote = {
  type: "remote",
  url: "https://mcp.notion.com/mcp",
  auth: { connection: "notion" },
};

describe("managed connection usage repositories", () => {
  const stepRepo = new DrizzleStepDefinitionRepo();
  const pipelineRepo = new DrizzlePipelineGraphRepo();

  concurrentTest(
    "selects latest active versions before matching auth",
    async () => {
      const projectId = await createProject();
      const otherProjectId = await createProject();
      const config = await createConfig(projectId, { notion: remote });
      const disabled = await createConfig(projectId, {
        notion: { ...remote, disabled: true },
      });
      const empty = await createConfig(projectId, null);
      const explicitEnabled = await createConfig(projectId, {
        notion: { ...remote, disabled: false },
        duplicate: remote,
      });
      const ref = await createConfig(projectId, {
        notion: {
          type: "ref",
          ref: "notion",
          auth: { connection: "notion" },
        },
      });
      const latest = await createStep(projectId, "latest", config);
      const latestVersion = await createStep(projectId, "latest", config, 2);
      await createStep(projectId, "latest", config, 3, "draft");
      await createStep(projectId, "latest", config, 4, "archived");
      const enabled = await createStep(projectId, "enabled", explicitEnabled);
      const referenced = await createStep(projectId, "ref", ref);
      await createStep(projectId, "removed", config);
      await createStep(projectId, "removed", empty, 2);
      await createStep(projectId, "now-default", config);
      await createStep(projectId, "now-default", null, 2);
      await createStep(projectId, "now-disabled", config);
      await createStep(projectId, "now-disabled", disabled, 2);
      await createStep(projectId, "draft", config, 1, "draft");
      await createStep(projectId, "archived", config, 1, "archived");
      await createStep(projectId, "disabled", disabled);
      await createStep(projectId, "default", null);
      await createStep(projectId, "empty", empty);
      await createStep(
        projectId,
        "no-auth",
        await createConfig(projectId, {
          notion: { type: "remote", url: remote.url },
        }),
      );
      await createStep(
        projectId,
        "local",
        await createConfig(projectId, {
          notion: { type: "local", command: ["notion"], auth: remote.auth },
        }),
      );
      await createStep(
        projectId,
        "other-provider",
        await createConfig(projectId, {
          notion: { ...remote, auth: { connection: "other" } },
        }),
      );
      await createStep(
        otherProjectId,
        "latest",
        await createConfig(otherProjectId, { notion: remote }),
        99,
      );

      const steps = await stepRepo.listLatestActiveByManagedConnectionName(
        projectId,
        "notion",
      );

      expect(steps.map((step) => step.id)).toEqual([
        enabled,
        latestVersion,
        referenced,
      ]);
      expect(steps.map((step) => ({ key: step.key, name: step.name }))).toEqual(
        [
          { key: "enabled", name: "Step enabled v1" },
          { key: "latest", name: "Step latest v2" },
          { key: "ref", name: "Step ref v1" },
        ],
      );
      expect(steps.some((step) => step.id === latest)).toBe(false);
    },
  );

  concurrentTest(
    "binds the provider as a value, not JSONPath syntax",
    async () => {
      const projectId = await createProject();
      const provider = 'notion") || true || (@.auth.connection == "';
      const config = await createConfig(projectId, {
        unusual: { ...remote, auth: { connection: provider } },
      });
      const id = await createStep(projectId, "unusual", config);
      await createStep(
        projectId,
        "ordinary",
        await createConfig(projectId, { notion: remote }),
      );

      expect(
        (
          await stepRepo.listLatestActiveByManagedConnectionName(
            projectId,
            provider,
          )
        ).map((step) => step.id),
      ).toEqual([id]);
      expect(
        await stepRepo.listLatestActiveByManagedConnectionName(
          projectId,
          "absent",
        ),
      ).toEqual([]);
    },
  );

  concurrentTest(
    "links only unarchived current pipelines with exact pins",
    async () => {
      const projectId = await createProject();
      const otherProjectId = await createProject();
      const oldStep = await createStep(projectId, "step", null);
      const currentStep = await createStep(projectId, "step", null, 2);
      const anotherStep = await createStep(projectId, "another", null);
      const createPipeline = async (
        key: string,
        pins: readonly UuidV7[],
        options: {
          projectId?: UuidV7;
          archived?: boolean;
          historicalPins?: readonly UuidV7[];
          noCurrent?: boolean;
        } = {},
      ) => {
        const id = createUuidV7();
        const currentVersionId = createUuidV7();
        await getDb()
          .insert(pipelineGraphs)
          .values({
            id,
            projectId: options.projectId ?? projectId,
            key,
            name: `Pipeline ${key}`,
            currentVersionId: options.noCurrent ? null : currentVersionId,
            archivedAt: options.archived ? new Date() : null,
          });
        const versions = [
          { id: currentVersionId, version: 2, pins },
          {
            id: createUuidV7(),
            version: 1,
            pins: options.historicalPins ?? [],
          },
        ];
        for (const version of versions) {
          await getDb().insert(pipelineGraphVersions).values({
            id: version.id,
            pipelineGraphId: id,
            version: version.version,
            definitionJson: {},
            schemaVersion: 1,
            contentHash: version.id,
          });
          if (version.pins.length > 0) {
            await getDb()
              .insert(pipelineGraphVersionSteps)
              .values(
                version.pins.map((stepDefinitionId, index) => ({
                  pipelineGraphVersionId: version.id,
                  stepKey: `step-${String(index)}`,
                  stepDefinitionId,
                })),
              );
          }
        }
        return id;
      };
      const included = await createPipeline(
        "included",
        [currentStep, currentStep, anotherStep],
        { historicalPins: [currentStep] },
      );
      const alsoIncluded = await createPipeline("also-included", [currentStep]);
      await createPipeline("pinned-old", [oldStep]);
      await createPipeline("historical-only", [oldStep], {
        historicalPins: [currentStep],
      });
      await createPipeline("archived", [currentStep], { archived: true });
      await createPipeline("no-current", [currentStep], { noCurrent: true });
      await createPipeline("other-project", [currentStep], {
        projectId: otherProjectId,
      });

      const uses = await pipelineRepo.listCurrentByStepDefinitionIds(
        projectId,
        [currentStep, anotherStep],
      );
      expect(
        uses.map((use) => ({
          stepId: use.stepDefinitionId,
          id: use.pipeline.id,
          key: use.pipeline.key,
          name: use.pipeline.name,
        })),
      ).toEqual([
        {
          stepId: currentStep,
          id: alsoIncluded,
          key: "also-included",
          name: "Pipeline also-included",
        },
        ...[currentStep, anotherStep].sort().map((stepId) => ({
          stepId,
          id: included,
          key: "included",
          name: "Pipeline included",
        })),
      ]);
      expect(
        await pipelineRepo.listCurrentByStepDefinitionIds(projectId, []),
      ).toEqual([]);
    },
  );
});
