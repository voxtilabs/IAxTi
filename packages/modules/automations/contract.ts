// Única puerta pública del módulo automations (SPEC §26).
export const MODULE_ID = 'automations' as const;
export {
  createRule,
  seedTemplates,
  listRules,
  getRule,
  setRuleActive,
  deleteRule,
  previewRule,
} from './application/rules';
export type { Rule, PreviewItem } from './application/rules';
export {
  runRule,
  handleAutomationEvent,
  automationConsumers,
  sweepTimeRules,
  listRuns,
  AUTOMATION_AUTHOR,
} from './application/engine';
export type { EngineDeps, RunResult } from './application/engine';
export {
  RULE_TEMPLATES,
  TRIGGER_EVENTS,
  ACTION_REQUIREMENTS,
  evaluateConditions,
  ruleModuleGaps,
  validateRule,
} from './domain/rules';
export type { Trigger, Condition, Action, ActionKind, RuleShape, RuleTemplate } from './domain/rules';
