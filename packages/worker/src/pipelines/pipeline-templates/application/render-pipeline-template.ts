/**
 * Renders a pipeline template's `.ts.tmpl` source into the `.ts` file the
 * pipeline-builder directory gets: parameter values replace the defaults in
 * the `@scarn-template-params` block, the entry's `definePipeline` or
 * `defineAutomation` key is set through its `@scarn-template-entry-key`
 * marker, every marker is removed, and a provenance header is prepended.
 *
 * Values are written as `JSON.stringify` literals into `const` lines that the
 * prompts read, so quotes, backticks and `${` in a value can't break the file.
 * Required parameters are not enforced here; callers that write a file check
 * them first.
 */
import {
  ENTRY_KEY_PATTERN,
  parameterConstName,
  PipelineTemplateRenderError,
  TEMPLATE_ENTRY_KEY_MARKER,
  TEMPLATE_MARKER_PREFIX,
  TEMPLATE_PARAMS_MARKER,
  type PipelineTemplate,
  type TemplateEntryKind,
} from "../domain/pipeline-template";

export type RenderPipelineTemplateOptions = {
  /** The CLI version named in the provenance header. */
  cliVersion: string;
  /** Values by parameter key. A parameter left out keeps its default. */
  parameterValues?: Readonly<Record<string, string>>;
  /** Overrides the template's `entry.key`, e.g. `wayfinder-2`. */
  entryKey?: string;
};

const PARAM_LINE = /^const ([A-Z][A-Z0-9_]*) = (.*);$/;
const ENTRY_KEY_LINE = new RegExp(
  `^(\\s*key:\\s*)"[^"\\\\]*",\\s*${escapeRegExp(TEMPLATE_ENTRY_KEY_MARKER)}\\s*$`,
);
const ENTRY_CALL = /\b(definePipeline|defineAutomation)\(/g;
const ENTRY_CALL_KIND: Record<string, TemplateEntryKind> = {
  definePipeline: "pipeline",
  defineAutomation: "automation",
};

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

/** The kind of the last `definePipeline(`/`defineAutomation(` call before `lineIndex`. */
function enclosingEntryKind(
  lines: string[],
  lineIndex: number,
): TemplateEntryKind | null {
  let kind: TemplateEntryKind | null = null;
  for (const line of lines.slice(0, lineIndex + 1)) {
    for (const match of line.matchAll(ENTRY_CALL)) {
      kind = ENTRY_CALL_KIND[match[1] ?? ""] ?? kind;
    }
  }
  return kind;
}

function setEntryKey(
  template: PipelineTemplate,
  lines: string[],
  entryKey: string,
): string[] {
  if (!ENTRY_KEY_PATTERN.test(entryKey)) {
    fail(
      template,
      `entry key "${entryKey}" may only contain letters, digits, '_' and '-'.`,
    );
  }
  const markerIndexes = lines.flatMap((line, index) =>
    line.includes(TEMPLATE_ENTRY_KEY_MARKER) ? [index] : [],
  );
  if (markerIndexes.length !== 1) {
    fail(
      template,
      `needs exactly one "${TEMPLATE_ENTRY_KEY_MARKER}" line, found ${String(markerIndexes.length)}.`,
    );
  }
  const index = markerIndexes[0] ?? 0;
  const match = ENTRY_KEY_LINE.exec(lines[index] ?? "");
  if (match === null) {
    fail(
      template,
      `the "${TEMPLATE_ENTRY_KEY_MARKER}" line must read \`key: "…", ${TEMPLATE_ENTRY_KEY_MARKER}\`.`,
    );
  }
  const call =
    template.entry.kind === "pipeline" ? "definePipeline" : "defineAutomation";
  if (enclosingEntryKind(lines, index) !== template.entry.kind) {
    fail(
      template,
      `the "${TEMPLATE_ENTRY_KEY_MARKER}" line must be inside the ${call}(…) call, since the entry is a ${template.entry.kind}.`,
    );
  }
  const rendered = `${match[1] ?? ""}${JSON.stringify(entryKey)},`;
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
  lines = setEntryKey(template, lines, options.entryKey ?? template.entry.key);
  const body = lines.join("\n");
  assertRendered(template, body);
  return `${provenanceHeader(template, options.cliVersion)}\n${body}`;
}
