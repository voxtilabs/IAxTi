// Única puerta pública del módulo agents (SPEC §26).
export const MODULE_ID = 'agents' as const;
export {
  PROVIDERS,
  TASKS,
  DEFAULT_TASK_MODELS,
  iaSettings,
  redactPII,
  estimateCostUsd,
} from './domain/config';
export type { Provider, AgentTask, TaskModel, IaSettings } from './domain/config';
export { createAgent, updateAgent, listAgents, getAgent } from './application/agents';
export type { Agent, AgentInput } from './application/agents';
export { runAgentTask, listExecutions, allowedToolsFor } from './application/runtime';
export type { RunInput, RunResult } from './application/runtime';
export { aiSdkModelPort, providerAvailable } from './application/models';
export type { ModelPort, ModelPortFactory, GenerateArgs, GenerateResult } from './application/models';
export { getVersionedPrompt, traceGeneration, langfuse, resetLangfuse } from './application/langfuse';
export {
  getQuota,
  afterExecutionQuota,
  isAutonomousPaused,
  costPerDay,
  costThisCycle,
} from './application/quota';
export type { QuotaState } from './application/quota';
export {
  suggestForInbound,
  pendingSuggestion,
  resolveSuggestion,
  feedbackSuggestion,
  conversationAnalysis,
  activeAgent,
  transcribeInboundAudio,
} from './application/copilot';
export type { Suggestion } from './application/copilot';
export { parseSuggestion, FORMATO_SUGERENCIA } from './domain/parser';
export type { SuggestionPayload } from './domain/parser';
export { aiSdkTranscriber } from './application/models';
export type { TranscribePort } from './application/models';
export {
  conversationMode,
  setConversationMode,
  effectiveMode,
  inAutonomousHours,
  guardrailLimits,
  escalate,
  autoRespondForInbound,
} from './application/autonomous';
export type { ConversationMode, AutonomousOutcome } from './application/autonomous';
export { detectEscalation, parseAutonomous, formatoAutonomo } from './domain/escalation';
export type { EscalationReason, AutonomousPayload } from './domain/escalation';
export {
  snapshotConfig,
  proposeConfiguration,
  getProposal,
  pendingProposal,
  applyProposal,
  dismissProposal,
} from './application/configurator';
export type { Proposal } from './application/configurator';
export {
  VERTICALS,
  VERTICAL_BASES,
  parseConfiguration,
  buildDiff,
  formatoConfiguracion,
} from './domain/configurator';
export type { Vertical, ConfigProposal, ConfigDiff, ConfigDiffItem, ConfigSnapshot } from './domain/configurator';
export {
  harvestFeedbackCases,
  listEvalCases,
  runEvaluation,
  listEvalRuns,
  latestScoreFor,
  evalGate,
} from './application/evaluation';
export type { EvalRun } from './application/evaluation';
export { formatoJuez, parseJudge } from './domain/judge';
export type { JudgeScores, EvalCase } from './domain/judge';
export {
  ejecutarHerramienta,
  HERRAMIENTAS_DE_LECTURA,
  HERRAMIENTAS_QUE_ESCRIBEN,
} from './application/herramientas';
export type { ResultadoHerramienta, DepsHerramientas } from './application/herramientas';
export { herramientasExpuestas } from './application/herramientas-expuestas';
export type { HerramientaExpuesta } from './application/models';
