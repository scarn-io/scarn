import {
  fetchHasEnabledProjectAutomation,
  fetchProject,
  fetchProjectPipelineDefinitions,
  fetchProjectStepDefinitions,
  fetchWorkItemFieldOptions,
  fetchWorkItemLabels,
  type WorkItemFieldFilterOption,
} from "@/app/(protected)/projects/_lib/project-work-items";
import {
  buildScoreSortCatalog,
  type ScoreSortPipeline,
} from "@/components/work-items/filters/score-sort-catalog";

/** Project-level data fetched once on mount, independent of the query params. */
export type ProjectShell = {
  projectName: string;
  hasEnabledProjectAutomation: boolean;
  scoreCatalog: ScoreSortPipeline[];
  labelOptions: string[];
};

/**
 * Loads the Work Items page's query-independent data. Only the project and its
 * pipeline definitions are required; step definitions, field options, labels
 * and the automation check are best-effort, since losing them costs a filter
 * or a hint rather than the whole page.
 */
export async function loadProjectWorkItemsShell(projectId: string): Promise<{
  shell: ProjectShell;
  fieldOptions: WorkItemFieldFilterOption[];
}> {
  const [
    project,
    definitions,
    stepDefinitions,
    fieldOptions,
    labelOptions,
    hasEnabledProjectAutomation,
  ] = await Promise.all([
    fetchProject(projectId),
    fetchProjectPipelineDefinitions(projectId),
    fetchProjectStepDefinitions(projectId).catch(() => []),
    fetchWorkItemFieldOptions(projectId).catch(
      (): WorkItemFieldFilterOption[] => [],
    ),
    fetchWorkItemLabels(projectId).catch((): string[] => []),
    fetchHasEnabledProjectAutomation(projectId).catch(() => false),
  ]);

  return {
    shell: {
      projectName: project.name,
      hasEnabledProjectAutomation,
      scoreCatalog: buildScoreSortCatalog(definitions, stepDefinitions),
      labelOptions,
    },
    fieldOptions,
  };
}
