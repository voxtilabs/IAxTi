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
