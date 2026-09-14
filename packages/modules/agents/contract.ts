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
