import { useEffect, useState } from "react";
import { templatePath } from "../router";
import { Link } from "../router-react";
import {
  formatOptionalSettings,
  formatSetupLabel,
  formatStepCount,
  hasStepConflicts,
} from "./template-card-labels";
import { fetchTemplates, type PipelineTemplateCard } from "./templates-api";

type GalleryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; cards: PipelineTemplateCard[] };

/**
 * Refetches whenever `refreshToken` changes, so a card's conflict badge
 * follows the builder directory (App passes the live snapshot's timestamp).
 */
function useTemplateCards(refreshToken: string | null): GalleryState {
  const [state, setState] = useState<GalleryState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const cards = await fetchTemplates(controller.signal);
        setState({ status: "ok", cards });
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
  }, [refreshToken]);

  return state;
}

function TemplateCard({ card }: { card: PipelineTemplateCard }) {
  const optionalSettings = formatOptionalSettings(card.parameters);
  return (
    <li>
      <Link href={templatePath(card.key)} className="studio-template-card">
        <h2 className="studio-template-card-name">{card.name}</h2>
        <p className="studio-template-card-summary">{card.summary}</p>
        <div className="studio-template-card-meta">
          <span>{formatStepCount(card)}</span>
          <span>{formatSetupLabel(card.parameters)}</span>
        </div>
        {optionalSettings ? (
          <p className="studio-template-card-optional">{optionalSettings}</p>
        ) : null}
        {hasStepConflicts(card) ? (
          <span className="studio-template-card-conflict">
            Conflicts with your steps
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/** `/templates`: one card per template the CLI ships. */
export function TemplateGallery({
  refreshToken,
}: {
  refreshToken: string | null;
}) {
  const state = useTemplateCards(refreshToken);

  if (state.status === "loading") {
    return <p className="studio-status">Loading templates…</p>;
  }
  if (state.status === "error") {
    return <p className="studio-status studio-status-error">{state.message}</p>;
  }
  if (state.cards.length === 0) {
    return <p className="studio-status">No templates available.</p>;
  }
  return (
    <ul className="studio-template-grid">
      {state.cards.map((card) => (
        <TemplateCard key={card.key} card={card} />
      ))}
    </ul>
  );
}
