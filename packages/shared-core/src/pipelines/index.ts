/**
 * Logic that works on pipeline documents: the validator, the condition
 * evaluator, the reference resolver and the graph helpers. What a document
 * is lives in `@scarn/sdk/contracts/pipeline-document`.
 */
export * from "./conditions/evaluate";
export * from "./references/parse";
export * from "./references/resolve";
export * from "./validate/types";
export { validatePipeline, type ValidationResult } from "./validate/validate";
export {
  buildGraph,
  checkReachBacks,
  dominates,
  dominatorsOf,
  isPrefix,
  reachableFrom,
  type Edge,
  type PipelineGraph,
  type ReachBack,
} from "./validate/graph";
export {
  allSplitIdOf,
  analyzeSplits,
  routeIdOf,
  splitIdOf,
  type Merge,
  type MergeField,
  type Split,
  type SplitAnalysis,
} from "./validate/splits";
