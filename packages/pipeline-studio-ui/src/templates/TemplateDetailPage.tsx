import { useEffect, useMemo, useState } from "react";
import { PipelineGraphView } from "../graph/PipelineGraphView";
import { pipelinePath, TEMPLATES_PATH } from "../router";
import { Link, navigate } from "../router-react";
import type { StudioTheme } from "../theme";
import { Markdown } from "./MarkdownView";
import { formatSetupLabel, formatStepCount } from "./template-card-labels";
import {
  buildTemplateGraph,
  decideUseAction,
  getUseButtonState,
  useSuccessMessage,
  useTarget,
} from "./template-detail-model";
import {
  fetchTemplate,
  postUseTemplate,
  type TemplateDetail,
  type UseTemplateResult,
} from "./templates-api";
import { TemplateStepDetails } from "./TemplateStepDetails";
import { showUseToast } from "./use-toast-store";
import { UseTemplateDialog } from "./UseTemplateDialog";

type DetailState =
  | { status: "loading" }
  | { status: "notFound" }
  | { status: "error"; message: string }
  | { status: "ok"; template: TemplateDetail };

/**
 * Loads the template, and reloads it whenever `refreshToken` changes so its
 * conflicts follow the builder directory. A reload keeps the page on screen.
 */
function useTemplateDetail(
  templateKey: string,
  refreshToken: string | null,
): DetailState {
  const [state, setState] = useState<DetailState>({ status: "loading" });

  useEffect(() => {
    setState({ status: "loading" });
  }, [templateKey]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const template = await fetchTemplate(templateKey, controller.signal);
        setState(
          template ? { status: "ok", template } : { status: "notFound" },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [templateKey, refreshToken]);

  return state;
}

/** A refused Use: the server's message, plus the step keys it found taken. */
type UseError = { message: string; takenStepKeys: string[] };

function useErrorFrom(
  result: Exclude<UseTemplateResult, { status: "ok" }>,
): UseError {
  return {
    message: result.error,
    takenStepKeys:
      result.status === "stepKeysTaken" ? result.takenStepKeys : [],
  };
}

function TemplateSideCard({
  template,
  submitting,
  error,
  onUse,
}: {
  template: TemplateDetail;
  submitting: boolean;
  error: UseError | null;
  onUse: () => void;
}) {
  const target = useTarget(template);
  const button = getUseButtonState(template);
  return (
    <aside className="studio-template-side">
      <h1 className="studio-template-side-name">{template.name}</h1>
      <p className="studio-template-side-summary">{template.summary}</p>
      {template.tags.length > 0 ? (
        <ul className="studio-template-tags">
          {template.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      ) : null}
      <dl className="studio-template-facts">
        <dt>Setup</dt>
        <dd>{formatSetupLabel(template.parameters)}</dd>
        <dt>Steps</dt>
        <dd>{formatStepCount(template)}</dd>
        <dt>Writes</dt>
        <dd>
          <code>{target.file}</code>
          {target.renamed ? (
            <span className="studio-template-renamed">
              {` "${template.pipelineKey}" is taken, so the pipeline is named "${target.pipelineKey}".`}
            </span>
          ) : null}
        </dd>
      </dl>
      <button
        type="button"
        className="studio-button studio-button-primary studio-template-use"
        disabled={button.disabled || submitting}
        onClick={onUse}
      >
        {submitting ? "Writing…" : "Use template"}
      </button>
      {button.disabled ? (
        <div className="studio-template-conflicts" role="status">
          <p>{button.reason}</p>
          <ul>
            {button.takenStepKeys.map((key) => (
              <li key={key}>
                <code>{key}</code>
              </li>
            ))}
          </ul>
          <p>Rename or remove them to use this template.</p>
        </div>
      ) : null}
      {error ? (
        <div className="studio-template-use-error" role="alert">
          <p>{error.message}</p>
          {error.takenStepKeys.length > 0 ? (
            <ul>
              {error.takenStepKeys.map((key) => (
                <li key={key}>
                  <code>{key}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function TemplateDetailView({
  template,
  theme,
}: {
  template: TemplateDetail;
  theme: StudioTheme;
}) {
  const graph = useMemo(() => buildTemplateGraph(template), [template]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cardError, setCardError] = useState<UseError | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const selectedNode =
    graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const target = useTarget(template);

  const submit = async (
    parameterValues: Record<string, string>,
    fromDialog: boolean,
  ) => {
    setSubmitting(true);
    setCardError(null);
    setDialogError(null);
    let result: UseTemplateResult;
    try {
      result = await postUseTemplate(template.key, parameterValues);
    } catch (error) {
      result = {
        status: "error",
        httpStatus: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    setSubmitting(false);
    if (result.status === "ok") {
      showUseToast(useSuccessMessage(result));
      navigate(pipelinePath(result.pipelineKey), { replace: true });
      return;
    }
    if (fromDialog && result.status === "invalidParameters") {
      setDialogError(result.error);
      return;
    }
    setDialogOpen(false);
    setCardError(useErrorFrom(result));
  };

  const onUse = () => {
    if (decideUseAction(template) === "post") {
      void submit({}, false);
    } else {
      setDialogError(null);
      setDialogOpen(true);
    }
  };

  return (
    <div className="studio-template-detail">
      <p className="studio-template-breadcrumb">
        <Link href={TEMPLATES_PATH}>← All templates</Link>
      </p>
      <div className="studio-template-preview">
        <div className="studio-template-graph">
          {graph.nodes.length > 0 ? (
            <PipelineGraphView
              key={`template:${template.key}`}
              nodes={graph.nodes}
              edges={graph.edges}
              colorMode={theme}
              onSelectNode={setSelectedNodeId}
              onDeselect={() => {
                setSelectedNodeId(null);
              }}
              refitKey={selectedNode ? "panel" : "full"}
            />
          ) : (
            <p className="studio-status">No pipeline graph to preview.</p>
          )}
        </div>
        {selectedNode ? (
          <aside className="studio-template-step-panel">
            <TemplateStepDetails
              node={selectedNode}
              steps={template.preview.steps}
              onClose={() => {
                setSelectedNodeId(null);
              }}
            />
          </aside>
        ) : null}
      </div>
      {template.preview.errors.length > 0 ? (
        <ul className="studio-template-preview-errors" role="alert">
          {template.preview.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      <div className="studio-template-body">
        <TemplateSideCard
          template={template}
          submitting={submitting && !dialogOpen}
          error={cardError}
          onUse={onUse}
        />
        <Markdown
          source={template.descriptionMarkdown}
          className="studio-markdown studio-template-description"
        />
      </div>
      {dialogOpen ? (
        <UseTemplateDialog
          templateName={template.name}
          parameters={template.parameters}
          targetFile={target.file}
          submitting={submitting}
          error={dialogError}
          onSubmit={(values) => {
            void submit(values, true);
          }}
          onCancel={() => {
            setDialogOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * `/templates/:key`: a read-only preview graph (hand-off steps in their own
 * dashed lane), a sticky side card with the Use button, and the template's
 * written description. `refreshToken` is the live snapshot's timestamp, so
 * the conflicts follow the builder directory.
 */
export function TemplateDetailPage({
  templateKey,
  refreshToken,
  theme,
}: {
  templateKey: string;
  refreshToken: string | null;
  theme: StudioTheme;
}) {
  const state = useTemplateDetail(templateKey, refreshToken);

  if (state.status === "loading") {
    return <p className="studio-status">Loading…</p>;
  }
  if (state.status === "notFound") {
    return (
      <p className="studio-status">
        {`No template "${templateKey}". `}
        <Link href={TEMPLATES_PATH}>See all templates</Link>.
      </p>
    );
  }
  if (state.status === "error") {
    return <p className="studio-status studio-status-error">{state.message}</p>;
  }
  return (
    <TemplateDetailView
      key={state.template.key}
      template={state.template}
      theme={theme}
    />
  );
}
