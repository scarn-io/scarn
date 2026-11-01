import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NodeDetailPanel } from "./graph/NodeDetailPanel";
import { PipelineGraphView } from "./graph/PipelineGraphView";
import { SeverityChip } from "./graph/SeverityChip";
import type {
  BrokenPipeline,
  StudioIssue,
  StudioSnapshot,
} from "./graph/studio-graph-types";
import { pipelinePath, type Route } from "./router";
import { Link, navigate, useRoute } from "./router-react";
import { StudioHeader } from "./StudioHeader";
import { TemplateDetailPage } from "./templates/TemplateDetailPage";
import { TemplateGallery } from "./templates/TemplateGallery";
import { UseTemplateToast } from "./templates/UseTemplateToast";
import { useStudioTheme, type StudioTheme } from "./theme";

/**
 * One issue row. Issues with no node (document-level or step-only ones)
 * render as a plain, non-interactive row; everything else is clickable and
 * selects the node it's about, swapping in `NodeDetailPanel` (see `App`).
 */
function IssueRow({
  issue,
  onSelectNode,
}: {
  issue: StudioIssue;
  onSelectNode: (nodeKey: string) => void;
}) {
  const body = (
    <>
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
    </>
  );
  if (issue.nodeId === undefined) {
    return <li className="studio-issue">{body}</li>;
  }

  const nodeKey = issue.nodeId;

  return (
    <li
      className="studio-issue studio-issue-clickable"
      role="button"
      tabIndex={0}
      onClick={() => {
        onSelectNode(nodeKey);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectNode(nodeKey);
        }
      }}
    >
      {body}
    </li>
  );
}

/**
 * Subscribes to the studio server's `/api/stream` SSE endpoint and re-renders
 * on every message. The stream itself is read-only; files written by the
 * template "Use" endpoint arrive here as a fresh snapshot.
 */
function useStudioSnapshot(): StudioSnapshot | null {
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        setSnapshot(JSON.parse(event.data) as StudioSnapshot);
      } catch (error) {
        console.error("Failed to parse studio snapshot", error);
      }
    };
    source.onerror = () => {
      // EventSource retries automatically; nothing to do but wait.
    };
    return () => {
      source.close();
    };
  }, []);

  return snapshot;
}

function IssuesPanel({
  issues,
  hasCompileErrors,
  onSelectNode,
}: {
  issues: readonly StudioIssue[];
  hasCompileErrors: boolean;
  onSelectNode: (nodeKey: string) => void;
}) {
  if (issues.length === 0) {
    return (
      <p className="studio-issues-empty">
        {hasCompileErrors
          ? "Files that fail to parse can't be validated — fix the errors above first."
          : "No validation issues."}
      </p>
    );
  }
  return (
    <ul className="studio-issues-list">
      {issues.map((issue, index) => (
        <IssueRow
          key={`${issue.code}-${issue.path ?? ""}-${String(index)}`}
          issue={issue}
          onSelectNode={onSelectNode}
        />
      ))}
    </ul>
  );
}

/**
 * Takes the graph's place when the selected entry failed to compile, so the
 * error is on screen the moment it's selected (or the moment the studio opens
 * on a directory with nothing working) rather than behind a dialog.
 */
function BrokenPipelinePanel({ pipeline }: { pipeline: BrokenPipeline }) {
  return (
    <section
      className="studio-broken"
      role="alert"
      aria-labelledby="studio-broken-title"
    >
      <h2 id="studio-broken-title" className="studio-broken-title">
        {`${pipeline.key} could not be read`}
      </h2>
      <pre className="studio-broken-message">{pipeline.message}</pre>
      <p className="studio-broken-hint">
        Fix the file in .scarn/pipeline-builder and save — the studio reloads
        automatically.
      </p>
    </section>
  );
}

/**
 * Every file that failed to compile, listed above the validation issues so the
 * sidebar never reads "No validation issues" while something is broken.
 * Clicking a row selects that entry, which shows its full error in place of
 * the graph.
 */
function CompileErrorsPanel({
  pipelines,
  selectedKey,
  onSelect,
}: {
  pipelines: readonly BrokenPipeline[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <>
      <h2>Unreadable files</h2>
      <ul className="studio-issues-list">
        {pipelines.map((pipeline) => (
          <li
            key={pipeline.key}
            className="studio-issue studio-issue-clickable"
            role="button"
            tabIndex={0}
            aria-current={pipeline.key === selectedKey ? "true" : undefined}
            onClick={() => {
              onSelect(pipeline.key);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(pipeline.key);
              }
            }}
          >
            <div className="studio-issue-header">
              <SeverityChip severity="error" />
              <span className="studio-issue-check">{pipeline.key}</span>
            </div>
            <span className="studio-compile-error-message">
              {pipeline.message}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function StudioPage({
  route,
  theme,
  onToggleTheme,
  children,
}: {
  route: Route;
  theme: StudioTheme;
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  return (
    <div className="studio-page">
      <StudioHeader route={route} theme={theme} onToggleTheme={onToggleTheme} />
      <main className="studio-page-main">{children}</main>
    </div>
  );
}

/**
 * `/` and `/pipelines/:key`: the graph of one pipeline from
 * `.scarn/pipeline-builder`. The selection lives in the URL, so the picker
 * navigates and Back restores the previous pipeline; `/` (or a key that no
 * longer exists) shows the first one.
 */
function PipelinesScreen({
  route,
  snapshot,
  theme,
  onToggleTheme,
}: {
  route: Extract<Route, { name: "pipelines" }>;
  snapshot: StudioSnapshot | null;
  theme: StudioTheme;
  onToggleTheme: () => void;
}) {
  const selectedKey = route.pipelineKey ?? null;
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);

  const pipelines = snapshot?.status === "ok" ? snapshot.pipelines : [];
  const brokenPipelines =
    snapshot?.status === "ok" ? snapshot.brokenPipelines : [];

  // A broken entry is shown only when it's explicitly selected, or when there
  // is no working pipeline to fall back to — then the first error is shown
  // straight away instead of an empty graph area.
  const selectedBroken = useMemo(
    () =>
      brokenPipelines.find((p) => p.key === selectedKey) ??
      (pipelines.length === 0 ? (brokenPipelines[0] ?? null) : null),
    [brokenPipelines, pipelines, selectedKey],
  );

  const selected = useMemo(
    () =>
      selectedBroken
        ? null
        : (pipelines.find((p) => p.key === selectedKey) ??
          pipelines[0] ??
          null),
    [pipelines, selectedBroken, selectedKey],
  );

  // A selected node id from a previous pipeline is meaningless (and likely
  // nonexistent) once the picker switches pipelines — reset to the issues
  // list rather than showing a stale/broken detail panel.
  useEffect(() => {
    setSelectedNodeKey(null);
  }, [selected?.key]);

  const selectedNode =
    selected?.nodes.find((n) => n.id === selectedNodeKey) ?? null;

  // The selected pipeline's own issues, plus step-only issues
  // (`pipelineKey === undefined`), which belong to no one pipeline and would
  // otherwise be unreachable from every picker selection.
  const validationIssues =
    snapshot?.status === "ok" ? snapshot.validationIssues : [];
  const filteredIssues = useMemo(
    () =>
      validationIssues.filter(
        (issue) =>
          issue.pipelineKey === selected?.key ||
          issue.pipelineKey === undefined,
      ),
    [validationIssues, selected],
  );

  const selectPipeline = (key: string) => {
    navigate(pipelinePath(key));
  };

  if (snapshot === null || snapshot.status === "error") {
    return (
      <StudioPage route={route} theme={theme} onToggleTheme={onToggleTheme}>
        {snapshot === null ? (
          <p className="studio-status">Connecting…</p>
        ) : (
          <p className="studio-status studio-status-error">
            {snapshot.message}
          </p>
        )}
      </StudioPage>
    );
  }

  if (pipelines.length === 0 && brokenPipelines.length === 0) {
    return (
      <StudioPage route={route} theme={theme} onToggleTheme={onToggleTheme}>
        <p className="studio-status">
          No pipelines found in .scarn/pipeline-builder yet. Start from a
          template:
        </p>
        <TemplateGallery refreshToken={snapshot.collectedAt} />
      </StudioPage>
    );
  }

  return (
    <div className="studio-layout">
      <StudioHeader route={route} theme={theme} onToggleTheme={onToggleTheme}>
        <select
          value={selected?.key ?? selectedBroken?.key ?? ""}
          onChange={(event) => {
            selectPipeline(event.target.value);
          }}
        >
          {pipelines.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
          {brokenPipelines.map((p) => (
            <option key={p.key} value={p.key} className="studio-option-broken">
              {`⚠ ${p.key} (error)`}
            </option>
          ))}
        </select>
      </StudioHeader>
      <div className="studio-graph">
        {selected ? (
          <PipelineGraphView
            key={selected.key}
            nodes={selected.nodes}
            edges={selected.edges}
            colorMode={theme}
            onSelectNode={setSelectedNodeKey}
            onDeselect={() => {
              setSelectedNodeKey(null);
            }}
          />
        ) : selectedBroken ? (
          <BrokenPipelinePanel pipeline={selectedBroken} />
        ) : null}
      </div>
      <aside className="studio-issues">
        {selectedNode ? (
          <NodeDetailPanel
            node={selectedNode}
            onBack={() => {
              setSelectedNodeKey(null);
            }}
          />
        ) : (
          <>
            {brokenPipelines.length > 0 ? (
              <CompileErrorsPanel
                pipelines={brokenPipelines}
                selectedKey={selectedBroken?.key ?? null}
                onSelect={selectPipeline}
              />
            ) : null}
            <h2>Validation issues</h2>
            <IssuesPanel
              issues={filteredIssues}
              hasCompileErrors={brokenPipelines.length > 0}
              onSelectNode={setSelectedNodeKey}
            />
          </>
        )}
      </aside>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const snapshot = useStudioSnapshot();
  const { theme, toggleTheme } = useStudioTheme();

  if (route.name === "pipelines") {
    return (
      <>
        <PipelinesScreen
          route={route}
          snapshot={snapshot}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <UseTemplateToast />
      </>
    );
  }

  return (
    <StudioPage route={route} theme={theme} onToggleTheme={toggleTheme}>
      {route.name === "templates" ? (
        <TemplateGallery refreshToken={snapshot?.collectedAt ?? null} />
      ) : route.name === "template" ? (
        <TemplateDetailPage
          templateKey={route.key}
          refreshToken={snapshot?.collectedAt ?? null}
          theme={theme}
        />
      ) : (
        <p className="studio-status">
          Page not found. <Link href="/">Back to pipelines</Link>.
        </p>
      )}
    </StudioPage>
  );
}
