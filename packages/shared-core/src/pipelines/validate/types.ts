/** Public types for the pipeline validator. */

export type ValidationErrorCode =
  | "schema"
  | "not_in_v1"
  | "unknown_node"
  | "unreachable_node"
  | "unknown_step"
  | "route_without_when"
  | "missing_arg"
  | "extra_arg"
  | "type_mismatch"
  | "invalid_reference"
  | "unknown_path"
  | "reference_not_allowed"
  | "reach_back"
  | "operator_type"
  | "invalid_condition"
  | "split"
  | "unknown_error_name"
  | "conversation_needs_turns";

export interface ValidationError {
  code: ValidationErrorCode;
  /** RFC 6901 JSON pointer into the document, e.g. `/nodes/fix/next/routes/1/args/plan`. */
  path: string;
  message: string;
  hint?: string;
}

/** `"<path>: <message> <hint>"`, the one-line form the CLI prints. */
export function formatValidationError(
  error: Pick<ValidationError, "path" | "message" | "hint">,
): string {
  const location = error.path === "" ? "/" : error.path;
  return error.hint === undefined
    ? `${location}: ${error.message}`
    : `${location}: ${error.message}. ${error.hint}`;
}
