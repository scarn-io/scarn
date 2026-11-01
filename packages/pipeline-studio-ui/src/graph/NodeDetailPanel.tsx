import type { ReactNode } from "react";
import type {
  StudioIssue,
  StudioNode,
  StudioSchemaField,
} from "./studio-graph-types";
import { SeverityChip } from "./SeverityChip";
import { nodeCaption, severityColor } from "./studio-graph-visuals";

/** One row of an issue list — full message text, colored by its own severity. */
function IssueMessageRow({ issue }: { issue: StudioIssue }) {
  return (
    <li
      className="studio-detail-issue"
      style={{ borderLeftColor: severityColor(issue.severity) }}
    >
      <div className="studio-issue-header">
        <SeverityChip severity={issue.severity} />
        <span className="studio-issue-check">{issue.code}</span>
      </div>
      {issue.message}
      {issue.hint ? (
        <div className="studio-issue-hint">{issue.hint}</div>
      ) : null}
      {issue.path ? (
        <code className="studio-issue-path">{issue.path}</code>
      ) : null}
    </li>
  );
}

function IssueMessageList({ issues }: { issues: readonly StudioIssue[] }) {
  if (issues.length === 0) {
    return <p className="studio-issues-empty">No validation issues.</p>;
  }
  return (
    <ul className="studio-detail-issue-list">
      {issues.map((issue, index) => (
        <IssueMessageRow
          key={`${issue.code}-${issue.path ?? ""}-${String(index)}`}
          issue={issue}
        />
      ))}
    </ul>
  );
}

/** A "required" pill shown next to schema field names. */
function RequiredBadge({ required }: { required: boolean }) {
  if (!required) return null;
  return <span className="studio-required-badge">required</span>;
}

function SchemaFieldsTable({
  fields,
  emptyText,
}: {
  fields: readonly StudioSchemaField[];
  emptyText: string;
}) {
  if (fields.length === 0) {
    return <p className="studio-detail-empty">{emptyText}</p>;
  }
  return (
    <table className="studio-detail-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Required</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.name}>
            <td>{field.name}</td>
            <td>{field.type}</td>
            <td>
              <RequiredBadge required={field.required} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The right-hand `<aside>`'s content when a node is selected — swapped in for
 * the issues list by `App.tsx`. Renders a step node's input and result
 * schema fields and declared errors, plus the node's own issue messages.
 *
 * The template detail page reuses it for its read-only preview: `notice`
 * shows under the caption (a hand-off step's "started by" line), `children`
 * adds the template step's settings, and `showIssues={false}` drops the
 * issues section, which a template preview has none of.
 */
export function NodeDetailPanel({
  node,
  onBack,
  backLabel = "← Back to issues",
  notice,
  showIssues = true,
  children,
}: {
  node: StudioNode;
  onBack: () => void;
  backLabel?: string;
  notice?: ReactNode;
  showIssues?: boolean;
  children?: ReactNode;
}) {
  const { data } = node;
  const { shape } = data;

  return (
    <div className="studio-detail">
      <button type="button" className="studio-detail-back" onClick={onBack}>
        {backLabel}
      </button>
      <h2 className="studio-detail-title">{data.label}</h2>
      <div className="studio-node-kind">{nodeCaption(data)}</div>
      {notice ? <p className="studio-detail-notice">{notice}</p> : null}
      {children}

      {shape.kind === "step" ? (
        <>
          <section className="studio-detail-section">
            <h3>Input fields</h3>
            <SchemaFieldsTable
              fields={shape.inputFields}
              emptyText="No declared input fields."
            />
          </section>
          <section className="studio-detail-section">
            <h3>Result fields</h3>
            <SchemaFieldsTable
              fields={shape.resultFields}
              emptyText="No declared result fields."
            />
          </section>
          <section className="studio-detail-section">
            <h3>Errors</h3>
            {shape.errors.length === 0 ? (
              <p className="studio-detail-empty">No declared errors.</p>
            ) : (
              <p>{shape.errors.join(", ")}</p>
            )}
          </section>
          <section className="studio-detail-section">
            <details>
              <summary>Result schema (raw JSON)</summary>
              <pre className="studio-detail-schema">
                {JSON.stringify(shape.resultSchemaJson, null, 2)}
              </pre>
            </details>
          </section>
        </>
      ) : null}

      {showIssues ? (
        <section className="studio-detail-section">
          <h3>Issues</h3>
          <IssueMessageList issues={data.issues} />
        </section>
      ) : null}
    </div>
  );
}
