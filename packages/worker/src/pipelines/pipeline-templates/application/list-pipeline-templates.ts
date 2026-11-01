import type {
  HandoffStep,
  PipelineTemplate,
  TemplateParameter,
} from "../domain/pipeline-template";
import { PIPELINE_TEMPLATES } from "../templates/registry";

/** Every pipeline template the CLI ships, in gallery order. */
export function listPipelineTemplates(): readonly PipelineTemplate[] {
  return PIPELINE_TEMPLATES;
}

export function findPipelineTemplate(
  key: string,
): PipelineTemplate | undefined {
  return PIPELINE_TEMPLATES.find((template) => template.key === key);
}

/** What a template's gallery card shows. */
export type PipelineTemplateCard = {
  key: string;
  name: string;
  summary: string;
  tags: string[];
  /** Steps the file exports, hand-off steps included. */
  stepCount: number;
  handoffStepCount: number;
  parameters: TemplateParameter[];
};

/** What a template's detail page shows, before its preview and conflicts. */
export type PipelineTemplateDescription = PipelineTemplateCard & {
  descriptionMarkdown: string;
  pipelineKey: string;
  stepKeys: string[];
  handoffSteps: HandoffStep[];
};

export function toPipelineTemplateCard(
  template: PipelineTemplate,
): PipelineTemplateCard {
  return {
    key: template.key,
    name: template.name,
    summary: template.summary,
    tags: [...template.tags],
    stepCount: template.stepKeys.length,
    handoffStepCount: template.handoffSteps.length,
    parameters: template.parameters.map((param) => ({ ...param })),
  };
}

export function describePipelineTemplate(
  template: PipelineTemplate,
): PipelineTemplateDescription {
  return {
    ...toPipelineTemplateCard(template),
    descriptionMarkdown: template.descriptionMarkdown,
    pipelineKey: template.pipelineKey,
    stepKeys: [...template.stepKeys],
    handoffSteps: template.handoffSteps.map((step) => ({ ...step })),
  };
}
