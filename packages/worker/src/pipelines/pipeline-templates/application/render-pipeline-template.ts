/**
 * Renders a pipeline template's `.ts.tmpl` source into the `.ts` file the
 * pipeline-builder directory gets: parameter values replace the defaults in
 * the `@scarn-template-params` block, the `definePipeline` key is set through
 * its `@scarn-template-pipeline-key` marker, every marker is removed, and a
 * provenance header is prepended.
 *
 * Values are written as `JSON.stringify` literals into `const` lines that the
 * prompts read, so quotes, backticks and `${` in a value can't break the file.
 * Required parameters are not enforced here; callers that write a file check
 * them first.
 */
import {
  parameterConstName,
  PIPELINE_KEY_PATTERN,
  PipelineTemplateRenderError,
  TEMPLATE_MARKER_PREFIX,
  TEMPLATE_PARAMS_MARKER,
  TEMPLATE_PIPELINE_KEY_MARKER,
  type PipelineTemplate,
} from "../domain/pipeline-template";

export type RenderPipelineTemplateOptions = {
  /** The CLI version named in the provenance header. */
  cliVersion: string;
  /** Values by parameter key. A parameter left out keeps its default. */
  parameterValues?: Readonly<Record<string, string>>;
  /** Overrides the template's `pipelineKey`, e.g. `wayfinder-2`. */
  pipelineKey?: string;
};

const PARAM_LINE = /^const ([A-Z][A-Z0-9_]*) = (.*);$/;
const PIPELINE_KEY_LINE = new RegExp(
  `^(\\s*key:\\s*)"[^"\\\\]*",\\s*${escapeRegExp(TEMPLATE_PIPELINE_KEY_MARKER)}\\s*$`,
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(template: PipelineTemplate, message: string): never {
  throw new PipelineTemplateRenderError(
    `Pipeline template "${template.key}": ${message}`,
  );
}

function assertKnownParameters(
  template: PipelineTemplate,
  values: Readonly<Record<string, string>>,
): void {
  const known = new Set(template.parameters.map((param) => param.key));
  const unknown = Object.keys(values).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    fail(
      template,
      `unknown parameter${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `"${key}"`).join(", ")}.`,
    );
  }
}

function substituteParameters(
  template: PipelineTemplate,
  lines: string[],
  values: Readonly<Record<string, string>>,
): string[] {
  const markerIndexes = lines.flatMap((line, index) =>
    line.trim() === TEMPLATE_PARAMS_MARKER ? [index] : [],
  );
  if (markerIndexes.length === 0) {
    if (template.parameters.length > 0) {
      fail(
        template,
        `has parameters but no "${TEMPLATE_PARAMS_MARKER}" block.`,
      );
    }
    return lines;
  }
  if (markerIndexes.length > 1) {
    fail(template, `has more than one "${TEMPLATE_PARAMS_MARKER}" block.`);
  }
  const start = (markerIndexes[0] ?? 0) + 1;
  let end = start;
  while (end < lines.length && PARAM_LINE.test(lines[end] ?? "")) end += 1;

  const byConst = new Map(
    template.parameters.map((param) => [parameterConstName(param.key), param]),
  );
  const declared = new Set<string>();
  const block = lines.slice(start, end).map((line) => {
    const match = PARAM_LINE.exec(line);
    const name = match?.[1] ?? "";
    const param = byConst.get(name);
    if (param === undefined) {
      fail(template, `"const ${name}" in the params block isn't a parameter.`);
    }
    declared.add(name);
    const value = values[param.key];
    return value === undefined
      ? line
      : `const ${name} = ${JSON.stringify(value)};`;
  });
  const undeclared = [...byConst.keys()].filter((name) => !declared.has(name));
  if (undeclared.length > 0) {
    fail(
      template,
      `the params block is missing ${undeclared.map((name) => `"const ${name}"`).join(", ")}.`,
    );
  }
  return [...lines.slice(0, start - 1), ...block, ...lines.slice(end)];
}

function setPipelineKey(
  template: PipelineTemplate,
  lines: string[],
  pipelineKey: string,
): string[] {
  if (!PIPELINE_KEY_PATTERN.test(pipelineKey)) {
    fail(
      template,
      `pipeline key "${pipelineKey}" may only contain letters, digits, '_' and '-'.`,
    );
  }
  const markerIndexes = lines.flatMap((line, index) =>
    line.includes(TEMPLATE_PIPELINE_KEY_MARKER) ? [index] : [],
  );
  if (markerIndexes.length !== 1) {
    fail(
      template,
      `needs exactly one "${TEMPLATE_PIPELINE_KEY_MARKER}" line, found ${String(markerIndexes.length)}.`,
    );
  }
  const index = markerIndexes[0] ?? 0;
  const match = PIPELINE_KEY_LINE.exec(lines[index] ?? "");
  if (match === null) {
    fail(
      template,
      `the "${TEMPLATE_PIPELINE_KEY_MARKER}" line must read \`key: "…", ${TEMPLATE_PIPELINE_KEY_MARKER}\`.`,
    );
  }
  const rendered = `${match[1] ?? ""}${JSON.stringify(pipelineKey)},`;
  return lines.map((line, i) => (i === index ? rendered : line));
}

/** Throws when a template marker survived rendering. */
export function assertRendered(
  template: PipelineTemplate,
  source: string,
): void {
  const leftover = source
    .split("\n")
    .findIndex((line) => line.includes(TEMPLATE_MARKER_PREFIX));
  if (leftover !== -1) {
    fail(
      template,
      `line ${String(leftover + 1)} still has a template marker after rendering.`,
    );
  }
}

export function provenanceHeader(
  template: PipelineTemplate,
  cliVersion: string,
): string {
  return `// Created from the ${JSON.stringify(template.key)} pipeline template (scarn ${cliVersion}).`;
}

export function renderPipelineTemplate(
  template: PipelineTemplate,
  options: RenderPipelineTemplateOptions,
): string {
  const values = options.parameterValues ?? {};
  assertKnownParameters(template, values);

  let lines = template.source.split("\n");
  lines = substituteParameters(template, lines, values);
  lines = setPipelineKey(
    template,
    lines,
    options.pipelineKey ?? template.pipelineKey,
  );
  const body = lines.join("\n");
  assertRendered(template, body);
  return `${provenanceHeader(template, options.cliVersion)}\n${body}`;
}
