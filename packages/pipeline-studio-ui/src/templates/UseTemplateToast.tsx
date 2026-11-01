import { dismissUseToast, useUseToast } from "./use-toast-store";

/**
 * The "template used" notice on the pipelines screen: the file written and
 * the next steps. It stays until dismissed, since it holds the commands to
 * copy.
 */
export function UseTemplateToast() {
  const message = useUseToast();
  if (!message) return null;
  return (
    <div className="studio-toast" role="status" aria-live="polite">
      <div className="studio-toast-header">
        <strong>Template added</strong>
        <button
          type="button"
          className="studio-toast-close"
          aria-label="Dismiss"
          onClick={dismissUseToast}
        >
          ×
        </button>
      </div>
      <p>
        Wrote <code>{message.path}</code>.
      </p>
      <p>Next steps:</p>
      <ol>
        <li>
          Run <code>{message.pushCommand}</code> to upload it.
        </li>
        <li>
          To start it on new work items by default, add{" "}
          <code>{message.assignSnippet}</code> to{" "}
          <code>{message.assignmentFile}</code>.
        </li>
      </ol>
    </div>
  );
}
