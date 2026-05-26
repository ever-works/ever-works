/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-1.
 *
 * AI-dispatch facade used by `AgentRunService.execute()` to invoke an
 * LLM chat-completion + drive the tool loop. Same indirection posture
 * as the other agent injection tokens (see
 * `docs/architecture/agent-injection-tokens.md`): the agent package
 * declares the contract; the API-side module binds it to a thin
 * adapter over `AiFacadeService.createChatCompletion`.
 *
 * Why a token, not direct injection: `AiFacadeService` lives in
 * `@ever-works/agent/facades`, which already imports
 * `DatabaseModule` / `UsageModule` / `BudgetsModule` — pulling that
 * graph into agent-side `AgentsModule` would balloon the cycle of
 * shared modules and make the agent package harder to embed
 * standalone (e.g. trigger.dev workers that only need the
 * orchestrator, not the database). Routing through a token keeps
 * agent-side AgentsModule's import list unchanged.
 */

export interface AgentAiToolDefinition {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export interface AgentAiToolCall {
    id: string;
    name: string;
    /** Tool call arguments as the model emitted them (already JSON-parsed). */
    args: unknown;
}

export interface AgentAiMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Present on assistant messages that emitted tool calls. */
    toolCalls?: AgentAiToolCall[];
    /** Present on `role: 'tool'` messages — references the originating tool call. */
    toolCallId?: string;
    /** Present on `role: 'tool'` messages — the tool name (some providers require it). */
    name?: string;
}

export interface AgentAiDispatchInput {
    /** Pre-assembled message thread (system + user + assistant-tool + tool history). */
    messages: AgentAiMessage[];
    tools?: AgentAiToolDefinition[];
    /** Resolved model id (from Agent.modelId or provider default). */
    model?: string;
    /** Pass-through to AiFacadeService — feeds Phase 15.6 attribution. */
    facadeOptions: {
        userId: string;
        workId?: string;
        agentId: string;
        taskId?: string;
        providerOverride?: string;
    };
    /** Optional temperature override. Default 0.4 (agent runs prefer determinism). */
    temperature?: number;
    /** Optional maxTokens cap. */
    maxTokens?: number;
}

export interface AgentAiDispatchResult {
    /** Assistant text reply — may be empty when the model only emitted tool calls. */
    text: string | null;
    /** Tool calls the model wants to invoke (empty array when none). */
    toolCalls: AgentAiToolCall[];
    /** Provider-reported finish reason; null when not surfaced. */
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    /** Token usage rollup; undefined when the provider didn't report it. */
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    /** Resolved model id the provider actually used. */
    model: string;
}

export interface AgentAiDispatchFacade {
    /**
     * One round-trip to the configured AI provider. The orchestrator
     * loops this with appended `assistant` (with toolCalls) + `tool`
     * (with results) messages until `toolCalls` is empty or the
     * tool-loop cap is reached.
     */
    dispatch(input: AgentAiDispatchInput): Promise<AgentAiDispatchResult>;
}

export const AGENT_AI_DISPATCH_FACADE = 'AGENT_AI_DISPATCH_FACADE' as const;
