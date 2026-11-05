import { NodeDetailPanel } from "../graph/NodeDetailPanel";
import type { StudioNode } from "../graph/studio-graph-types";
import { InlineMarkdown } from "./MarkdownView";
import {
  describeGrants,
  detachedStepNotice,
  findTemplateStep,
  formatRepoAccess,
  formatRuntime,
} from "./template-detail-model";
import type { TemplateEntryKind, TemplateStepPreview } from "./templates-api";

function SchemaJson({
  title,
  schema,
}: {
  title: string;
  schema: Record<string, unknown>;
}) {
  return (
    <section className="studio-detail-section">
      <details>
        <summary>{title}</summary>
        <pre className="studio-detail-schema">
          {JSON.stringify(schema, null, 2)}
        </pre>
      </details>
    </section>
  );
}

/**
 * A template step's prompt and settings, below the schema tables. Schemas
 * are shown raw only for nodes without a resolved step shape (detached
 * steps), since `NodeDetailPanel` already shows them for graph steps.
 */
function TemplateStepSections({
  step,
  showSchemas,
}: {
  step: TemplateStepPreview;
  showSchemas: boolean;
}) {
  return (
    <>
      {step.description ? (
        <p className="studio-detail-description">{step.description}</p>
      ) : null}
      <section className="studio-detail-section">
        <h3>Settings</h3>
        <table className="studio-detail-table">
          <tbody>
            <tr>
              <th scope="row">Runtime</th>
              <td>{formatRuntime(step.runtime)}</td>
            </tr>
            <tr>
              <th scope="row">Repository</th>
              <td>{formatRepoAccess(step.repo)}</td>
            </tr>
            <tr>
              <th scope="row">Work item grants</th>
              <td>{describeGrants(step.grants)}</td>
            </tr>
            <tr>
              <th scope="row">Max turns</th>
              <td>
                {step.maxTurns === null ? "Default" : String(step.maxTurns)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <section className="studio-detail-section">
        <h3>Prompt</h3>
        {step.prompt ? (
          <pre className="studio-detail-schema">{step.prompt}</pre>
        ) : (
          <p className="studio-detail-empty">No prompt.</p>
        )}
      </section>
      {showSchemas && step.inputSchema ? (
        <SchemaJson title="Input schema (raw JSON)" schema={step.inputSchema} />
      ) : null}
      {showSchemas && step.resultSchema ? (
        <SchemaJson
          title="Result schema (raw JSON)"
          schema={step.resultSchema}
        />
      ) : null}
    </>
  );
}

/**
 * The template detail page's side panel for a clicked preview node: the
 * shared `NodeDetailPanel` plus the step's prompt and settings. A detached
 * step is headed with what starts it. Read-only; nothing here is written.
 */
export function TemplateStepDetails({
  node,
  steps,
  entryKind,
  onClose,
}: {
  node: StudioNode;
  steps: readonly TemplateStepPreview[];
  entryKind: TemplateEntryKind;
  onClose: () => void;
}) {
  const step = findTemplateStep(steps, node);
  return (
    <NodeDetailPanel
      node={node}
      onBack={onClose}
      backLabel="← Close"
      showIssues={false}
      notice={
        node.data.kind === "detached" ? (
          <InlineMarkdown text={detachedStepNotice(entryKind)} />
        ) : null
      }
    >
      {step ? (
        <TemplateStepSections
          step={step}
          showSchemas={node.data.shape.kind === "none"}
        />
      ) : null}
    </NodeDetailPanel>
  );
}
