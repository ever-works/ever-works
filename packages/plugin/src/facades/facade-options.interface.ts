export interface FacadeOptions {
	readonly userId: string;
	readonly workId?: string;
	readonly providerOverride?: string;

	/**
	 * Agents/Skills/Tasks PR #1017 — Phase 15.6.
	 *
	 * When an AI/search/screenshot/content-extractor call is made on
	 * behalf of an Agent run, the orchestrator passes the Agent's id
	 * here so the resulting `PluginUsageEvent` rows carry the
	 * attribution. Feeds the per-Agent budget rollup +
	 * `getTotalSpendCentsForOwner('agent', agentId, ...)`.
	 */
	readonly agentId?: string;

	/**
	 * Agents/Skills/Tasks PR #1017 — Phase 15.6.
	 *
	 * Set on calls dispatched from a `task` or `chat` AgentRun. Feeds
	 * the per-Task spend endpoint
	 * (`GET /api/tasks/:id/spend` → `getTotalSpendCentsForTask`).
	 * Heartbeat runs leave this undefined.
	 */
	readonly taskId?: string;
}
