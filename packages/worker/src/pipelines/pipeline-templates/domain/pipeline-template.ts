/**
 * A pipeline template: TypeScript source shipped with the CLI that renders
 * into one `<pipelineKey>.ts` file in the pipeline-builder directory, holding
 * one pipeline and every step it uses.
 *
 * The source carries two kinds of marker comment the renderer reads:
 *
 * - `// @scarn-template-params`, followed by one `const NAME = <json>;` line
 *   per parameter. `NAME` is the parameter's key in upper case, and the
 *   value is its default. Rendering replaces each value with the
 *   `JSON.stringify`ed parameter value, so values never touch prompt text.
 * - `// @scarn-template-pipeline-key` at the end of the `definePipeline`
 *   `key: "…",` line, so the key can be renamed without searching prompts.
 */

export type TemplateParameterType = "text" | "textarea";

export type TemplateParameter = {
  key: string;
  label: string;
  description?: string | null;
  type: TemplateParameterType;
  required: boolean;
  placeholder?: string | null;
};

/** A step the file exports but the graph doesn't contain: an agent starts it. */
export type HandoffStep = {
  key: string;
  /** The step key whose agent starts it. */
  startedBy: string;
  summary: string;
};

export type PipelineTemplate = {
  key: string;
  name: string;
  /** One line, for the gallery card. */
  summary: string;
  /** The detail page body. */
  descriptionMarkdown: string;
  tags: string[];
  /** The default file name and `definePipeline` key. */
  pipelineKey: string;
  /** Every step the file exports, for collision checks. */
  stepKeys: string[];
  handoffSteps: HandoffStep[];
  parameters: TemplateParameter[];
  /** The `.ts.tmpl` text. */
  source: string;
};

export const TEMPLATE_PARAMS_MARKER = "// @scarn-template-params";
export const TEMPLATE_PIPELINE_KEY_MARKER = "// @scarn-template-pipeline-key";
export const TEMPLATE_MARKER_PREFIX = "@scarn-template-";

/** The same shape a pipeline document's node ids take. */
export const PIPELINE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class PipelineTemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineTemplateRenderError";
  }
}

/** The `const` a parameter renders into. */
export function parameterConstName(parameterKey: string): string {
  return parameterKey.toUpperCase();
}
