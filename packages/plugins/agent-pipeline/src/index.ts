/**
 * Agent Pipeline Plugin
 *
 * AI agent pipeline that uses Vercel AI SDK (generateText + tools) to
 * generate work items via an autonomous agent loop. The agent has
 * tools for web search, content extraction, file management, and
 * progress reporting, all running in an in-memory sandbox.
 *
 * @packageDocumentation
 */

export { AgentPipelinePlugin } from './agent-pipeline.plugin.js';

// Types
export type { AgentPipelineStepId } from './types.js';
export { AGENT_PIPELINE_STEP_IDS, isAgentPipelineStepId, DEFAULT_MAX_STEPS } from './types.js';

// Default export for plugin loader
export { default } from './agent-pipeline.plugin.js';
