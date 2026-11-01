import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  initialParameterValues,
  missingRequiredParameters,
  parameterValuesToSubmit,
} from "./template-detail-model";
import type { TemplateParameter } from "./templates-api";

/**
 * The parameter form a Use opens for a template with parameters. Fields
 * start blank, showing the template's placeholder; a field left blank keeps
 * the template's default. Submit is enabled as soon as every required field
 * has a value, so a template with only optional parameters can be used
 * straight away. `error` is the server's refusal of the last submit.
 */
export function UseTemplateDialog({
  templateName,
  parameters,
  targetFile,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  templateName: string;
  parameters: readonly TemplateParameter[];
  targetFile: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState(() =>
    initialParameterValues(parameters),
  );
  const missing = missingRequiredParameters(parameters, values);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="studio-dialog"
      aria-labelledby="studio-use-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) onCancel();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (missing.length > 0 || submitting) return;
          onSubmit(parameterValuesToSubmit(values));
        }}
      >
        <h2 id="studio-use-dialog-title" className="studio-dialog-title">
          {`Use ${templateName}`}
        </h2>
        <p className="studio-dialog-target">
          Writes <code>{targetFile}</code>
        </p>
        {parameters.map((param) => {
          const id = `studio-param-${param.key}`;
          const common = {
            id,
            name: param.key,
            value: values[param.key] ?? "",
            placeholder: param.placeholder ?? undefined,
            required: param.required,
            disabled: submitting,
            onChange: (
              event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
            ) => {
              const { value } = event.target;
              setValues((previous) => ({ ...previous, [param.key]: value }));
            },
          };
          return (
            <div key={param.key} className="studio-dialog-field">
              <label htmlFor={id}>
                {param.label}
                {param.required ? null : (
                  <span className="studio-dialog-optional"> (optional)</span>
                )}
              </label>
              {param.description ? (
                <p className="studio-dialog-help">{param.description}</p>
              ) : null}
              {param.type === "textarea" ? (
                <textarea rows={4} {...common} />
              ) : (
                <input type="text" {...common} />
              )}
            </div>
          );
        })}
        {error ? (
          <p className="studio-status-error studio-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="studio-dialog-actions">
          <button
            type="button"
            className="studio-button"
            disabled={submitting}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="studio-button studio-button-primary"
            disabled={submitting || missing.length > 0}
          >
            {submitting ? "Writing…" : "Use template"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
