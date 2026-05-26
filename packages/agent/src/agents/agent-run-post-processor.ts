/**
 * Agents/Skills/Tasks PR #1017 — Phase 15.5.
 *
 * Post-processing hooks for the `task` and `chat` AgentRun kinds.
 * `AgentRunService.finalize()` calls into these once the LLM dispatch
 * lands; the platform binds the tokens to the real `TaskChatService`
 * and `TasksService` from `TasksDomainModule`, while unit tests +
 * the heartbeat path leave them unbound (no-op).
 *
 * Same posture as `task-dispatcher.ts` (Phase 15.3 / 15.4): keep the
 * `@ever-works/agent` graph free of a `@ever-works/agent/tasks-domain`
 * runtime import. Wiring happens in `apps/api/src/agents/agents.module.ts`.
 */

export interface AgentChatBackPostInput {
	userId: string;
	taskId: string;
	/** Agent posting the reply — used as the chat-row author. */
	agentId: string;
	body: string;
}

export interface AgentRunChatBackPoster {
	postReply(input: AgentChatBackPostInput): Promise<{ messageId: string }>;
}

export interface AgentTaskFinishInput {
	userId: string;
	taskId: string;
	/** Target status — typically `done` on success, `blocked` on need-input. */
	to: 'done' | 'in_review' | 'blocked' | 'cancelled';
	/** Forces past approver gate (not blocker) — security spec §6. */
	force?: boolean;
}

export interface AgentRunTaskFinisher {
	finishTask(input: AgentTaskFinishInput): Promise<{ status: string }>;
}

export const AGENT_RUN_CHAT_BACK_POSTER = 'AGENT_RUN_CHAT_BACK_POSTER' as const;
export const AGENT_RUN_TASK_FINISHER = 'AGENT_RUN_TASK_FINISHER' as const;

/**
 * Outcome supplied by the LLM dispatch path to `AgentRunService.finalize()`.
 *
 * `summary` — short human-readable completion summary persisted on the
 * AgentRun row.
 * `replyBody` — when present on a `chat` kind run, the orchestrator
 * auto-posts this back to the Task chat thread as an agent-authored
 * message (T6 chat-dedup posture still applies upstream).
 * `taskFinishStatus` — when present on a `task` kind run, the
 * orchestrator flips the Task status to this value via TaskTransitionService.
 * `force` — passed through to the transition call. Approver gate only.
 * `errored` — when true, the AgentRun row is marked failed instead of
 * completed and side-effects are skipped.
 */
export interface AgentRunOutcome {
	summary?: string | null;
	replyBody?: string | null;
	taskFinishStatus?: AgentTaskFinishInput['to'] | null;
	force?: boolean;
	errored?: boolean;
	errorMessage?: string;
}
