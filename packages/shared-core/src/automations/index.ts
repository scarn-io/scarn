/**
 * Logic that works on automation documents: the publish-time validator and
 * the `event.*` reference types. What a document is lives in
 * `@scarn/sdk/contracts/automation-document`.
 */
export {
  validateAutomation,
  type AutomationCatalog,
  type AutomationValidationResult,
} from "./validate";
export { resolveEventReference } from "./event-refs";
