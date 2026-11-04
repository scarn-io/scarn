/**
 * The automation authoring SDK: rules that start steps or pipelines when
 * something happens to a work item, compiled to an automation JSON document
 * with `defineAutomation`. Conditions are the pipeline condition helpers.
 */
export { defineAutomation, onEvent, attach, skip } from "./define-automation";
export type {
  AutomationConfig,
  AutomationDefinition,
  AutomationTarget,
  BareStep,
  ChildEvent,
  EventContext,
  EventOf,
  EventWorkItem,
  PipelineCall,
  Rule,
  RuleOptions,
  RuleRoute,
  RuleRoutesOptions,
  RuleTarget,
  RuleTargetArg,
  RuleToOptions,
  ScopeOf,
} from "./types";
export type {
  AutomationDocument,
  AutomationEvent,
  AutomationScope,
  AutomationSubject,
  ProjectAutomationEvent,
  WorkItemAutomationEvent,
} from "../contracts/automation-document";
