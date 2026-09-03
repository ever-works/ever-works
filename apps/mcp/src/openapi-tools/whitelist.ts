export interface WhitelistEntry {
	method: string;
	path: string;
	toolName?: string;
	description?: string;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
	};
}

export const WHITELIST: WhitelistEntry[] = [
	// Works (12)
	{
		method: 'GET',
		path: '/api/works',
		toolName: 'list_works',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/works', toolName: 'create_work' },
	{
		method: 'GET',
		path: '/api/works/{id}',
		toolName: 'get_work',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PUT', path: '/api/works/{id}', toolName: 'update_work' },
	{
		method: 'POST',
		path: '/api/works/{id}/delete',
		toolName: 'delete_work',
		annotations: { destructiveHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/config',
		toolName: 'get_work_config',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/items',
		toolName: 'get_work_items',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/categories-tags',
		toolName: 'get_categories_tags',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/history',
		toolName: 'get_work_history',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/works/{id}/regenerate-markdown', toolName: 'regenerate_markdown' },
	{ method: 'POST', path: '/api/works/{id}/update-website', toolName: 'update_website' },
	{ method: 'POST', path: '/api/works/{id}/process-community-prs', toolName: 'process_community_prs' },

	// Generation (4)
	{ method: 'POST', path: '/api/works/{id}/generate', toolName: 'generate_items' },
	{ method: 'POST', path: '/api/works/{id}/update', toolName: 'update_items' },
	{ method: 'POST', path: '/api/works/generate-details', toolName: 'generate_work_details' },
	{
		method: 'GET',
		path: '/api/works/{id}/generator-form',
		toolName: 'get_generator_form',
		annotations: { readOnlyHint: true }
	},

	// Items (4)
	{ method: 'POST', path: '/api/works/{id}/submit-item', toolName: 'submit_item' },
	{ method: 'POST', path: '/api/works/{id}/remove-item', toolName: 'remove_item' },
	{ method: 'POST', path: '/api/works/{id}/update-item', toolName: 'update_item' },
	{ method: 'POST', path: '/api/extract-item-details', toolName: 'extract_item_details' },

	// Deploy (4)
	{ method: 'POST', path: '/api/deploy/works/{id}', toolName: 'deploy_work' },
	{
		method: 'GET',
		path: '/api/deploy/works/{id}/domains',
		toolName: 'list_domains',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/deploy/providers',
		toolName: 'list_deploy_providers',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/deploy/works/{id}/check', toolName: 'check_deploy_capability' },

	// Plugins (5)
	{
		method: 'GET',
		path: '/api/plugins',
		toolName: 'list_plugins',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/plugins/{pluginId}',
		toolName: 'get_plugin',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/plugins/{pluginId}/enable', toolName: 'enable_plugin' },
	{ method: 'POST', path: '/api/plugins/{pluginId}/disable', toolName: 'disable_plugin' },
	{ method: 'PATCH', path: '/api/plugins/{pluginId}/settings', toolName: 'update_plugin_settings' },

	// Scheduling (4)
	{
		method: 'GET',
		path: '/api/works/{id}/schedule',
		toolName: 'get_schedule',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PUT', path: '/api/works/{id}/schedule', toolName: 'update_schedule' },
	{
		method: 'DELETE',
		path: '/api/works/{id}/schedule',
		toolName: 'cancel_schedule',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/works/{id}/schedule/run', toolName: 'run_scheduled_update' },

	// Comparisons (5)
	{
		method: 'GET',
		path: '/api/works/{id}/comparisons',
		toolName: 'list_comparisons',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/works/{id}/comparisons/{slug}',
		toolName: 'get_comparison',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/works/{id}/comparisons/generate', toolName: 'generate_comparison' },
	{
		method: 'POST',
		path: '/api/works/{id}/comparisons/generate-manual',
		toolName: 'generate_manual_comparison'
	},
	{
		method: 'DELETE',
		path: '/api/works/{id}/comparisons/{slug}',
		toolName: 'delete_comparison',
		annotations: { destructiveHint: true }
	},

	// ────────────────────────────────────────────────────────────
	// Phase 9 PR Z2 — Missions / Ideas / account-wide usage.
	// Mirrors the web-side chat tools (PR Z1) so external MCP
	// clients (Cursor, Claude Desktop, etc.) reach the same verbs.
	// Tool names use the dashed-resource convention already used
	// above (snake_case actions + singular nouns). All routes are
	// ownership-gated server-side via `@CurrentUser()` + the
	// per-service `getForUser` 404 path — no extra MCP-side ACL
	// needed.
	// ────────────────────────────────────────────────────────────

	// Missions (14)
	{
		method: 'GET',
		path: '/api/me/missions',
		toolName: 'list_missions',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/me/missions', toolName: 'create_mission' },
	{
		method: 'GET',
		path: '/api/me/missions/{id}',
		toolName: 'get_mission',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/me/missions/{id}/budget',
		toolName: 'get_mission_budget',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PATCH', path: '/api/me/missions/{id}', toolName: 'update_mission' },
	{
		method: 'DELETE',
		path: '/api/me/missions/{id}',
		toolName: 'delete_mission',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/me/missions/{id}/pause', toolName: 'pause_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/resume', toolName: 'resume_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/complete', toolName: 'complete_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/clone', toolName: 'clone_mission' },
	{ method: 'POST', path: '/api/me/missions/{id}/run-now', toolName: 'run_mission_now' },
	// PR-2 (domain-model evolution) — Mission ↔ Work typed relations.
	// Attach/detach only records HOW a Mission relates to a Work
	// (created|improves|operates|markets|researches|retires); it never
	// transfers ownership and detach never touches the Work itself.
	{
		method: 'GET',
		path: '/api/me/missions/{id}/works',
		toolName: 'list_mission_works',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/me/missions/{id}/works', toolName: 'attach_work_to_mission' },
	{
		method: 'DELETE',
		path: '/api/me/missions/{id}/works/{workId}/{relation}',
		toolName: 'detach_work_from_mission',
		annotations: { destructiveHint: true }
	},

	// Ideas / Work-Proposals (13)
	{ method: 'POST', path: '/api/me/work-proposals', toolName: 'create_idea' },
	{
		method: 'GET',
		path: '/api/me/work-proposals',
		toolName: 'list_ideas',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/me/work-proposals/status',
		toolName: 'get_ideas_refresh_status',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/me/work-proposals/refresh', toolName: 'refresh_ideas' },
	{
		method: 'GET',
		path: '/api/me/work-proposals/preferences',
		toolName: 'get_idea_preferences',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'PUT',
		path: '/api/me/work-proposals/preferences',
		toolName: 'update_idea_preferences'
	},
	{
		method: 'GET',
		path: '/api/me/work-proposals/{id}',
		toolName: 'get_idea',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/me/work-proposals/{id}/budget',
		toolName: 'get_idea_budget',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'PATCH',
		path: '/api/me/work-proposals/{id}/dismiss',
		toolName: 'dismiss_idea',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/me/work-proposals/{id}/build', toolName: 'build_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/retry', toolName: 'retry_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/rebuild', toolName: 'rebuild_idea' },
	{ method: 'POST', path: '/api/me/work-proposals/{id}/accept', toolName: 'accept_idea' },

	// Account-wide usage (1)
	{
		method: 'GET',
		path: '/api/me/usage/account-wide',
		toolName: 'get_account_usage',
		annotations: { readOnlyHint: true }
	},

	// Self-build program (EW-762 / EW-769) — the work-orchestration surface.
	// An external agent (Claude Code with this server attached, a CI bot, a
	// desktop assistant) drives Tasks, answers the Inbox, steers Goals and
	// Agents and watches the Fleet. Every route is owner-scoped by the API
	// itself; the hints below only tell the MCP client what a call means.

	// Tasks (24) — `apps/api/src/tasks/tasks.controller.ts`
	{
		method: 'GET',
		path: '/api/tasks',
		toolName: 'list_tasks',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/tasks', toolName: 'create_task' },
	{ method: 'POST', path: '/api/tasks/run-batch', toolName: 'run_tasks_batch' },
	{
		method: 'GET',
		path: '/api/tasks/{id}',
		toolName: 'get_task',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PATCH', path: '/api/tasks/{id}', toolName: 'update_task' },
	{
		method: 'DELETE',
		path: '/api/tasks/{id}',
		toolName: 'delete_task',
		annotations: { destructiveHint: true }
	},
	{
		method: 'GET',
		path: '/api/tasks/{id}/subtasks',
		toolName: 'list_task_subtasks',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/tasks/{id}/activity',
		toolName: 'get_task_activity',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/tasks/{id}/transition', toolName: 'transition_task' },
	{
		method: 'GET',
		path: '/api/tasks/{id}/run-candidates',
		toolName: 'get_task_run_candidates',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/tasks/{id}/run', toolName: 'run_task' },
	{
		method: 'GET',
		path: '/api/tasks/{id}/pr-status',
		toolName: 'get_task_pr_status',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/tasks/{id}/diff',
		toolName: 'get_task_diff',
		annotations: { readOnlyHint: true }
	},
	// Throws away the Task's pushed branch; the platform cannot get it back.
	{
		method: 'POST',
		path: '/api/tasks/{id}/discard-branch',
		toolName: 'discard_task_branch',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/tasks/{id}/reject', toolName: 'reject_task' },
	{ method: 'POST', path: '/api/tasks/{id}/assignees', toolName: 'assign_task' },
	{ method: 'POST', path: '/api/tasks/{id}/reviewers', toolName: 'add_task_reviewer' },
	{ method: 'POST', path: '/api/tasks/{id}/approvers', toolName: 'add_task_approver' },
	{ method: 'POST', path: '/api/tasks/{id}/relations', toolName: 'add_task_relation' },
	{
		method: 'GET',
		path: '/api/tasks/{id}/escalations',
		toolName: 'list_task_escalations',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'POST',
		path: '/api/tasks/{id}/escalations/{escalationId}/resolve',
		toolName: 'resolve_task_escalation'
	},
	{
		method: 'GET',
		path: '/api/tasks/{id}/chat',
		toolName: 'get_task_chat',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/tasks/{id}/chat', toolName: 'post_task_chat_message' },
	{
		method: 'GET',
		path: '/api/tasks/{id}/spend',
		toolName: 'get_task_spend',
		annotations: { readOnlyHint: true }
	},

	// Inbox (8) — `apps/api/src/inbox/inbox.controller.ts`. Where agents ask
	// humans for decisions; `reply_inbox_item` is how an approval is given.
	{
		method: 'GET',
		path: '/api/inbox',
		toolName: 'list_inbox',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/inbox/unread-count',
		toolName: 'get_inbox_unread_count',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/inbox/{id}',
		toolName: 'get_inbox_item',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/inbox/{id}/reply', toolName: 'reply_inbox_item' },
	{ method: 'PATCH', path: '/api/inbox/{id}/read', toolName: 'mark_inbox_item_read' },
	{ method: 'POST', path: '/api/inbox/{id}/archive', toolName: 'archive_inbox_item' },
	{ method: 'POST', path: '/api/inbox/{id}/unarchive', toolName: 'unarchive_inbox_item' },
	{
		method: 'DELETE',
		path: '/api/inbox/{id}',
		toolName: 'delete_inbox_item',
		annotations: { destructiveHint: true }
	},

	// Goals (11) — `apps/api/src/goals/goals.controller.ts` (`/api/me/goals`).
	{
		method: 'GET',
		path: '/api/me/goals',
		toolName: 'list_goals',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/me/goals', toolName: 'create_goal' },
	{
		method: 'GET',
		path: '/api/me/goals/{id}',
		toolName: 'get_goal',
		annotations: { readOnlyHint: true }
	},
	{ method: 'PATCH', path: '/api/me/goals/{id}', toolName: 'update_goal' },
	{
		method: 'GET',
		path: '/api/me/goals/{id}/samples',
		toolName: 'get_goal_samples',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/me/goals/{id}/activate', toolName: 'activate_goal' },
	{ method: 'POST', path: '/api/me/goals/{id}/pause', toolName: 'pause_goal' },
	{ method: 'POST', path: '/api/me/goals/{id}/evaluate-now', toolName: 'evaluate_goal_now' },
	{ method: 'PATCH', path: '/api/me/goals/{id}/limits', toolName: 'update_goal_limits' },
	{ method: 'POST', path: '/api/me/goals/{id}/dod/propose', toolName: 'propose_goal_dod' },
	{ method: 'POST', path: '/api/me/goals/{id}/dod/approve', toolName: 'approve_goal_dod' },

	// Fleet (8) — `apps/api/src/fleet/fleet.controller.ts` and
	// `fleet-agent-affinity.controller.ts`. Owner-facing reads plus the two
	// operator actions an agent may legitimately take (pin an Agent to a
	// machine, drain a machine). Node-facing routes (enroll, heartbeat,
	// lease, complete) and enrollment tokens are deliberately NOT exposed.
	{
		method: 'GET',
		path: '/api/fleet/nodes',
		toolName: 'list_fleet_nodes',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}',
		toolName: 'get_fleet_node',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/runner-status',
		toolName: 'get_fleet_runner_status',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/execution-preferences',
		toolName: 'get_fleet_execution_preferences',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/agents/{agentId}/node-affinity',
		toolName: 'get_agent_node_affinity',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'PUT',
		path: '/api/fleet/agents/{agentId}/node-affinity',
		toolName: 'set_agent_node_affinity'
	},
	{
		method: 'DELETE',
		path: '/api/fleet/agents/{agentId}/node-affinity',
		toolName: 'clear_agent_node_affinity',
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/fleet/nodes/{id}/drain', toolName: 'drain_fleet_node' },

	// Agents (9) — `apps/api/src/agents/agents.controller.ts`. Read the
	// roster and run history, kick or cancel a run, pause / resume.
	{
		method: 'GET',
		path: '/api/agents',
		toolName: 'list_agents',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/agents/{id}',
		toolName: 'get_agent',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/agents/{id}/runs',
		toolName: 'list_agent_runs',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/agents/{id}/runs/{runId}',
		toolName: 'get_agent_run',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/agents/{id}/run-now', toolName: 'run_agent_now' },
	{ method: 'POST', path: '/api/agents/{id}/runs/{runId}/cancel', toolName: 'cancel_agent_run' },
	{ method: 'POST', path: '/api/agents/{id}/pause', toolName: 'pause_agent' },
	{ method: 'POST', path: '/api/agents/{id}/resume', toolName: 'resume_agent' },
	{
		method: 'GET',
		path: '/api/agents/{id}/budget',
		toolName: 'get_agent_budget',
		annotations: { readOnlyHint: true }
	}
];
