// Parses an automation's latest document for the automation round view, turning
// a schema failure into an `AutomationGraphError` the panel shows inline.
import {
  automationDocumentSchema,
  type AutomationDocument,
} from "@scarn/sdk/contracts/automation-document";

export type AutomationGraphInput = {
  key: string;
  /** The latest version's document. */
  document: unknown;
};

/** An automation whose latest document doesn't parse as an automation document. */
export class AutomationGraphError extends Error {
  readonly automationKey: string;

  constructor(automationKey: string, detail: string) {
    super(`Automation "${automationKey}" has an invalid document: ${detail}`);
    this.name = "AutomationGraphError";
    this.automationKey = automationKey;
  }
}

/** Parses the document, or throws `AutomationGraphError` with the first issue. */
export function parseAutomationDocument({
  key,
  document,
}: AutomationGraphInput): AutomationDocument {
  const result = automationDocumentSchema.safeParse(document);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const detail =
    issue === undefined
      ? "unknown error"
      : issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message;
  throw new AutomationGraphError(key, detail);
}
