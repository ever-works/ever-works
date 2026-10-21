import { MACHINE_PRINCIPAL_WORK_WRITABLE_FIELDS } from '@ever-works/contracts';

export interface WhitelistEntry {
	method: string;
	path: string;
	toolName?: string;
	description?: string;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
	};
	/**
	 * Argument names the tool must NOT expose or forward, even though the
	 * OpenAPI operation accepts them. Why: some routes carry a flag that turns
	 * an ordinary verb into a human-only override (`force` on a Task
	 * transition skips the approver gate; `requireAllApprovers` on a Task
	 * create/update decides whether that gate runs at all). The route stays
	 * useful without the flag, so we keep the tool and cut the flag out of both
	 * the generated schema and the outbound request instead of dropping the
	 * whole route.
	 */
	omitArgs?: string[];
	/**
	 * When set, the ONLY body arguments the tool exposes and forwards; path and
	 * query parameters are kept. The allowlist twin of {@link omitArgs}, for a
	 * route whose safe body is small and whose new fields must stay off the
	 * tool until someone lists them (works-security lane 3a).
	 */
	bodyArgs?: readonly string[];
	/**
	 * Works-security (2026-10-18) — the tool writes Task `labels`, and must
	 * not add or remove a RESERVED one (`awaiting-owner`, `app-provision`,
	 * `release:*`, `provision-attempt-*`; `@ever-works/contracts`
	 * `isReservedTaskLabel`). `create`: none may be sent. `update`: the
	 * handler reads the Task first and refuses a list that differs from it in
	 * any reserved label. The API cannot tell an MCP call from the owner's own
	 * session when the server forwards the caller's JWT, so the check lives
	 * here. Off with `TASK_RESERVED_LABELS_ENFORCED=false`.
	 */
	reservedTaskLabels?: 'create' | 'update';
}

/**
 * Prefix for the node-affinity tool descriptions. Hand-written (trusted)
 * text, so the connected LLM learns up front that the call needs an
 * Organization scope instead of discovering it from a 400.
 */
const AFFINITY_SCOPE_NOTE =
	'Requires an Organization scope: set EVER_WORKS_SCOPE_SLUG to the Organization slug on the MCP server, otherwise the API answers 400.';

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
	// Works-security lane 3a (2026-10-18): the tool edits a Work's descriptive
	// text ONLY (`MACHINE_PRINCIPAL_WORK_WRITABLE_FIELDS`, the same allowlist
	// the API applies to fleet-run tokens and integration keys). Every other
	// setting on the route decides what the platform later does without a
	// person — a Work-level `mergePolicy` overrides every broader scope and the
	// merge gate auto-merges on green CI when it allows; `checkDefaults` /
	// `repoDeclaredCommands` are shell commands a node executes; the
	// `taskIsolation*`, community-PR, ownership, template, deploy and committer
	// fields route and attribute later work. An agent bound to this server
	// could otherwise loosen its own merge gate or plant the commands its next
	// run executes. A person changes them in the Work settings.
	{
		method: 'PUT',
		path: '/api/works/{id}',
		toolName: 'update_work',
		bodyArgs: MACHINE_PRINCIPAL_WORK_WRITABLE_FIELDS
	},
	{
		method: 'POST',
		path: '/api/works/{id}/delete',
		toolName: 'delete_work',
		// APW-01 T39 (FR-40b, Resolution R-15): the App Work delete surface adds two
		// fields whose only purpose is to authorise DESTROYING the App Work's stored
		// data (volumes and App dependencies) — `delete_stored_data` and its typed
		// `confirm_slug`. Neither is advertised as a tool argument and neither is
		// forwarded, so no agent can destroy stored data through MCP; the route stays
		// useful without them (deleting the Work keeps the data).
		//
		// Works-security lane 3a: the same goes for the owner's GitHub
		// repositories — `delete_data_repository`, `delete_website_repository`,
		// `delete_markdown_repository` — and `force_delete`. Deleting a Work
		// through a tool keeps its repositories; the API refuses the flags for
		// fleet-run tokens and integration keys as well.
		omitArgs: [
			'delete_stored_data',
			'confirm_slug',
			'delete_data_repository',
			'delete_website_repository',
			'delete_markdown_repository',
			'force_delete'
		],
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
	// desktop assistant) drives Tasks, triages the Inbox, steers Goals and
	// Agents and watches the Fleet. Every route is owner-scoped by the API
	// itself; the hints below only tell the MCP client what a call means.
	//
	// Human-in-the-loop gates are deliberately NOT exposed. The API cannot
	// tell an MCP caller holding the owner's key from the owner, so any
	// verb that ANSWERS a gate would let an Agent bound to this server
	// approve its own proposal, resolve its own escalation or sign off its
	// own definition of done. Kept out (and pinned by the whitelist spec):
	//   POST /api/inbox/{id}/reply                          (approve/reject/resume)
	//   POST /api/tasks/{id}/escalations/{escalationId}/resolve
	//   POST /api/me/goals/{id}/dod/approve
	//   `force` on POST /api/tasks/{id}/transition           (approver-gate override)
	//   `requireAllApprovers` on POST /api/tasks and PATCH /api/tasks/{id}
	//                                                        (whether that gate runs at all)
	// The asking side stays: an agent can propose criteria, post to a Task's
	// chat, list escalations and read the Inbox; a person answers in the app.

	// Tasks (23) — `apps/api/src/tasks/tasks.controller.ts`
	{
		method: 'GET',
		path: '/api/tasks',
		toolName: 'list_tasks',
		annotations: { readOnlyHint: true }
	},
	// `requireAllApprovers` is the approver POLICY: the `→ done` transition only
	// runs its approver check while the flag is true, so `false` skips it
	// outright (not even an any-approver check). Setting it on create or
	// flipping it on update is therefore the same override as `force` — a
	// caller could pre-disarm a Task a person later adds approvers to, or turn
	// the gate off and move to done without it. Both tools lose the field; a
	// machine-created Task keeps the API default (`true`) and a person changes
	// the policy in the app.
	//
	// `acceptanceChecks` (works-security lane 3a) are shell commands a fleet
	// node runs — `phase: 'setup'` entries before the model, the rest as the
	// quality gate — and the planner treats them as owner-authored. A tool
	// caller could plant the command the next run executes, so both tools lose
	// the field too; the API refuses it for fleet-run tokens and integration
	// keys, and a person adds checks in the app.
	//
	// `labels` stay writable, but never a reserved one (works-security
	// 2026-10-18): `awaiting-owner` holds a Task for its owner, `release:*`
	// forces a human approval on a promotion / revert, `provision-attempt-*`
	// is a retry cap. An agent steered by injected text must not lift a hold
	// or drop an approval by rewriting the list (`reservedTaskLabels`).
	{
		method: 'POST',
		path: '/api/tasks',
		toolName: 'create_task',
		omitArgs: ['requireAllApprovers', 'acceptanceChecks'],
		reservedTaskLabels: 'create'
	},
	{ method: 'POST', path: '/api/tasks/run-batch', toolName: 'run_tasks_batch' },
	{
		method: 'GET',
		path: '/api/tasks/{id}',
		toolName: 'get_task',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'PATCH',
		path: '/api/tasks/{id}',
		toolName: 'update_task',
		omitArgs: ['requireAllApprovers', 'acceptanceChecks'],
		reservedTaskLabels: 'update'
	},
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
	// `force` skips the approver gate on `→ done` (and the quality-gate
	// refusal on `→ in_review`); that override belongs to a person, so the
	// tool keeps the ordinary state-machine move and loses the flag.
	// `mode` (works-security lane 3a): `sync` is the integrations' mirror walk,
	// which starts no agent work at all — for an agent's move that would also
	// cancel the reviewer stage. The tool moves one status at a time.
	{
		method: 'POST',
		path: '/api/tasks/{id}/transition',
		toolName: 'transition_task',
		omitArgs: ['force', 'mode']
	},
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

	// Inbox (7) — `apps/api/src/inbox/inbox.controller.ts`. Where agents ask
	// humans for decisions. Read and triage only: the reply route is the
	// approval itself and stays out (see the note above).
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
	{ method: 'PATCH', path: '/api/inbox/{id}/read', toolName: 'mark_inbox_item_read' },
	{ method: 'POST', path: '/api/inbox/{id}/archive', toolName: 'archive_inbox_item' },
	{ method: 'POST', path: '/api/inbox/{id}/unarchive', toolName: 'unarchive_inbox_item' },
	{
		method: 'DELETE',
		path: '/api/inbox/{id}',
		toolName: 'delete_inbox_item',
		annotations: { destructiveHint: true }
	},

	// Goals (10) — `apps/api/src/goals/goals.controller.ts` (`/api/me/goals`).
	// `propose_goal_dod` appends criteria for a person to approve; the
	// approve route is a human gate and stays out (see the note above).
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

	// Fleet (8) — `apps/api/src/fleet/fleet.controller.ts` and
	// `fleet-agent-affinity.controller.ts`. Owner-facing reads plus the two
	// operator actions an agent may legitimately take (pin an Agent to a
	// machine, drain a machine). Node-facing routes (enroll, heartbeat,
	// lease, complete) and enrollment tokens are deliberately NOT exposed.
	//
	// Node affinity is an Organization feature: the API answers 400 unless
	// the request runs under an Organization scope, and an MCP call only
	// carries one when `EVER_WORKS_SCOPE_SLUG` is set (forwarded as
	// `x-scope-slug`). The explicit descriptions say so, because the spec
	// summaries alone leave the LLM guessing why the tool refused.
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
		description: `${AFFINITY_SCOPE_NOTE} Read which of the owner's Fleet nodes this Organization Agent is pinned to (null = any).`,
		annotations: { readOnlyHint: true }
	},
	{
		method: 'PUT',
		path: '/api/fleet/agents/{agentId}/node-affinity',
		toolName: 'set_agent_node_affinity',
		description: `${AFFINITY_SCOPE_NOTE} Pin this Organization Agent to one of the owner's Fleet nodes.`
	},
	{
		method: 'DELETE',
		path: '/api/fleet/agents/{agentId}/node-affinity',
		toolName: 'clear_agent_node_affinity',
		description: `${AFFINITY_SCOPE_NOTE} Return this Organization Agent to "any of my Fleet nodes" (idempotent; queued jobs keep their node).`,
		annotations: { destructiveHint: true }
	},
	{ method: 'POST', path: '/api/fleet/nodes/{id}/drain', toolName: 'drain_fleet_node' },

	// Checkouts on computers (6) — FL-14, `apps/api/src/fleet/checkouts/
	// fleet-checkouts.controller.ts`, the same names as the Agent tools
	// (CONTRACTS §11.3). Pull, push, archive and delete answer
	// `confirmation_required` first; the caller repeats with `confirm` /
	// `confirmName` (CONTRACTS §2.2). The node-facing credential route
	// (`/api/fleet/checkouts/{id}/credential`) is deliberately NOT exposed.
	{
		method: 'GET',
		path: '/api/fleet/checkouts',
		toolName: 'fleet_checkouts_list',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/checkouts/{id}',
		toolName: 'fleet_checkouts_get',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/fleet/checkouts', toolName: 'fleet_checkouts_create' },
	{ method: 'POST', path: '/api/fleet/checkouts/{id}/sync', toolName: 'fleet_checkouts_sync' },
	{ method: 'POST', path: '/api/fleet/checkouts/{id}/archive', toolName: 'fleet_checkouts_archive' },
	{
		method: 'DELETE',
		path: '/api/fleet/checkouts/{id}',
		toolName: 'fleet_checkouts_delete',
		annotations: { destructiveHint: true }
	},

	// Tasks on computers (3) — FL-15 (CONTRACTS §11.3). The hand-off options for a Task (read-only;
	// the start itself is `fleet_sessions_start` with `taskId`), and a computer's global git
	// identity: read, and "Use my Ever Works identity" (class `confirm`: the first call answers
	// `confirmation_required` with what would be set; repeat with `confirm: true`).
	// (The two reads — `fleet_tasks_handoff_options`, `fleet_nodes_git_identity_get` — sit in FL-19's block below.)
	{ method: 'POST', path: '/api/fleet/nodes/{id}/git/identity', toolName: 'fleet_nodes_git_identity_set' },
	// GitHub: things for me (FL-15 P3) — one event Trigger over GitHub events about me.
	{
		method: 'POST',
		path: '/api/inbound-triggers/presets/github-for-me',
		toolName: 'inbound_triggers_github_for_me'
	},

	// Logs on computers (2) — `apps/api/src/fleet/logs/fleet-logs.controller.ts`
	// (FL-08, CONTRACTS §11.3). Both read-only: list a computer's log sources,
	// read at most 500 secret-scanned lines of one. The read never follows; a
	// `follow` argument is cut from the tool (the route refuses it anyway).
	// Dark (404) unless the deployment sets FLEET_MACHINE_FACTS_ENABLED.
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/logs/sources',
		toolName: 'fleet_logs_sources',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'POST',
		path: '/api/fleet/nodes/{id}/logs/read',
		toolName: 'fleet_logs_read',
		annotations: { readOnlyHint: true },
		omitArgs: ['follow']
	},

	// Sessions on computers (5) — FL-04 P2, `apps/api/src/fleet/sessions/fleet-sessions.controller.ts`
	// (dark unless FLEET_SESSIONS_ENABLED). A person's sessions on their computers: list, read, start,
	// rename, end (CONTRACTS §2.2 class `confirm`: without `confirm: true` the API answers
	// `confirmation_required` with the sentence to show). Typing into a session is the Agent-side
	// `fleet_sessions_send` tool only — there is no REST input route; full parity is FL-19.
	{
		method: 'GET',
		path: '/api/fleet/sessions',
		toolName: 'fleet_sessions_list',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/sessions/{id}',
		toolName: 'fleet_sessions_read',
		annotations: { readOnlyHint: true }
	},
	{ method: 'POST', path: '/api/fleet/nodes/{id}/sessions', toolName: 'fleet_sessions_start' },
	{ method: 'PATCH', path: '/api/fleet/sessions/{id}', toolName: 'fleet_sessions_rename' },
	{
		method: 'POST',
		path: '/api/fleet/sessions/{id}/end',
		toolName: 'fleet_sessions_end',
		annotations: { destructiveHint: true }
	},
	// FL-05 P2 — answering what a session asks (a question or a permission prompt): an option the CLI
	// showed or a free text; the attention (what it asks) rides `fleet_sessions_read`.
	{
		method: 'POST',
		path: '/api/fleet/sessions/{id}/answer',
		toolName: 'fleet_sessions_answer',
		description:
			"Answer what one of my sessions on a computer is waiting for: one of the options it showed (optionId) or, for a question that takes one, a free text. key is the session's attention key (from fleet_sessions_read). Refused once it was answered (in the terminal too), and while the computer is away."
	},

	// Commands on computers (4) — FL-12 P2, `apps/api/src/fleet/commands/fleet-commands.controller.ts`
	// (dark unless FLEET_COMMANDS_ENABLED). One command line on one or more of the caller's computers, in
	// the machine owner's login shell with no input. CONTRACTS §2.2 class `confirm`: without
	// `confirm: true` the API answers `confirmation_required` with one line per computer; repeat the call
	// with `confirm: true` once the person agreed. Output is read back with `fleet_commands_get`.
	{
		method: 'POST',
		path: '/api/fleet/commands',
		toolName: 'fleet_commands_run',
		description:
			"Run one shell command on one or more of my fleet computers, in the machine owner's login shell, as the owner, with no input (prompts fail). These are real machines, not a sandbox. Without confirm: true it answers confirmation_required with one line per computer (shell, folder, or why it cannot run); repeat with confirm: true once agreed. Answers one run per computer; read the output with fleet_commands_get.",
		annotations: { destructiveHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/commands',
		toolName: 'fleet_commands_list',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/commands/{id}',
		toolName: 'fleet_commands_get',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'POST',
		path: '/api/fleet/commands/{id}/cancel',
		toolName: 'fleet_commands_cancel',
		annotations: { destructiveHint: false }
	},

	// Servers and ports (FL-10, CONTRACTS §2.1) — `apps/api/src/fleet/ports/fleet-ports.controller.ts`.
	// The list is a read of the machine (nothing stored, nothing audited); open is
	// not destructive — it opens the port's page ON the machine (its desktop or its
	// preview browser) and is audited `node.port.open`. Dark unless
	// FLEET_MACHINE_FACTS_ENABLED.
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/ports',
		toolName: 'fleet_ports_list',
		description:
			'List the TCP ports a fleet computer is listening on, read on the machine: web servers first (title, status, program or container), other ports, hidden system ports. Read-only.',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'POST',
		path: '/api/fleet/nodes/{id}/ports/{port}/open',
		toolName: 'fleet_ports_open',
		description:
			"Open a fleet computer's web server ON that machine: its default browser on its desktop, or its preview browser (a profile no agent uses). Takes a port number only; audited.",
		annotations: { destructiveHint: false }
	},
	// FL-10 P2 — close a preview tunnel (dark unless FLEET_PORT_TUNNEL_ENABLED). Opening one is NOT
	// exposed here: its answer carries a one-time address into the owner's tunnel, which a tool must
	// never hold (spec U15); the in-platform Agent tool opens one without that address.
	{
		method: 'DELETE',
		path: '/api/fleet/nodes/{id}/ports/{port}/preview',
		toolName: 'fleet_ports_preview_close',
		description: "Close the person's preview tunnel to a port on a fleet computer.",
		annotations: { destructiveHint: false }
	},

	// Virtual computers (FL-16, plan §9, CONTRACTS §11.3) — `apps/api/src/fleet/virtual/fleet-virtual.controller.ts`.
	// Same names as the in-platform Agent tools. Acts satisfy their confirmation class
	// with the request fields (`confirm: true`, `confirmName`); without them the API
	// answers 409 `confirmation_required` with the summary to show. Dark unless
	// FLEET_VIRTUAL_ENABLED.
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/virtual',
		toolName: 'fleet_virtual_list',
		description:
			'List the virtual computers (Containers, Windows VMs) a fleet computer hosts, with system, size, create phase and state, and the host memory net of what they reserve. Read-only.',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/virtual/options',
		toolName: 'fleet_virtual_options',
		description:
			'Which fleet computers can host a new virtual computer of a system (?system=), with free memory, free disk, KVM and why each other one cannot, plus the systems, sizes and the host "Choose for me" picks ({id} may be `auto`). Read-only.',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'POST',
		path: '/api/fleet/nodes/{id}/virtual',
		toolName: 'fleet_virtual_create',
		description:
			'Create a Container on a fleet computer ({id}, or `auto` for the host with the most free memory). It uses that computer’s CPU, memory and disk; no credits are spent. Needs `confirm: true`; without it the answer is 409 with the host, CPUs, memory and disk to confirm.',
		annotations: { destructiveHint: true }
	},
	{
		method: 'POST',
		path: '/api/fleet/nodes/{id}/virtual/{childId}/power',
		toolName: 'fleet_virtual_power',
		description:
			'Start or stop a virtual computer (`action: start | stop`; stop needs `confirm: true` — a Container stops within 10 seconds).',
		annotations: { destructiveHint: true }
	},
	{
		method: 'POST',
		path: '/api/fleet/nodes/{id}/virtual/{childId}/destroy',
		toolName: 'fleet_virtual_destroy',
		description:
			'Destroy a virtual computer: its machine and disk on the host, then its Fleet registration (job history is kept). Irreversible; needs `confirmName` = its name. Refused while a Run or a session is live on it.',
		annotations: { destructiveHint: true }
	},

	// Agent, MCP & CLI surface (FL-19 P1, CONTRACTS §11.3) — the read-only half of the fleet tool
	// catalogue (`FLEET_TOOL_CATALOGUE`): `fleet_status`, computer health (FL-03), services,
	// processes and Docker (FL-09), long operations (FL-02). Same names as the Agent tools; each
	// route keeps its own flag (404 while dark). `fleet_nodes_list|get` are the Agent names of the
	// routes the legacy `list_fleet_nodes` / `get_fleet_node` entries above already expose, which
	// stay exactly as they are (spec FR-3). Enrolment, heartbeat, lease, attach-token and
	// credential routes are never exposed (spec FR-17).
	{
		method: 'GET',
		path: '/api/fleet/status',
		toolName: 'fleet_status',
		description:
			'How is my fleet, in one call: every computer I may see (status, platform, consents, CPU / memory / disk, live sessions), what needs a look on them with the fix for each, whether the fleet kill switch is on, and the server time. Read-only.',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/health',
		toolName: 'fleet_nodes_health',
		description:
			"One fleet computer's health from its latest check-in (CPU, memory, disk, load, uptime, GPU, pending reboot, failed services), whether it is stale, and its state in plain words with its one fix. Read-only.",
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/needs-a-look',
		toolName: 'fleet_nodes_needs_a_look',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/services',
		toolName: 'fleet_services_list',
		description:
			"The services on one fleet computer (systemd, launchd or Windows services), failed first, read on the machine. Needs the computer's services audience and --manage. Read-only.",
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/processes',
		toolName: 'fleet_processes_list',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/docker/containers',
		toolName: 'fleet_docker_containers_list',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/docker/images',
		toolName: 'fleet_docker_images_list',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/docker/compose',
		toolName: 'fleet_docker_compose_list',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/operations/{id}',
		toolName: 'fleet_operations_get',
		description:
			'A long operation on one of my fleet computers (a call that answered with an operationId): running, done, failed, cancelled or interrupted, its progress, and the result or the error. An interrupted operation never reads done. Read-only; poll it while it runs.',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/operations',
		toolName: 'fleet_operations_list',
		annotations: { readOnlyHint: true }
	},
	// Tasks & GitHub on the fleet (FL-15) — the reads behind "Fix on a computer" and the Git card
	// (dark unless FLEET_CHECKOUTS_ENABLED; hand-off options also need FLEET_SESSIONS_ENABLED).
	{
		method: 'GET',
		path: '/api/fleet/nodes/{id}/git/identity',
		toolName: 'fleet_nodes_git_identity_get',
		description:
			"The git identity (name and email) a fleet computer commits as, read on the machine, and where it comes from. Read-only.",
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/fleet/tasks/{taskId}/handoff-options',
		toolName: 'fleet_tasks_handoff_options',
		description:
			'Where a Task could be fixed on one of my computers: the computers that can take it, the checkouts of its repository on each, and the agents available there. Start the session with fleet_sessions_start and the taskId. Read-only.',
		annotations: { readOnlyHint: true }
	},

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
	},

	// Agent Plugins (EW-772) — READ ONLY, deliberately.
	//
	// Installing an Agent Plugins package means installing SKILLS, and a skill
	// is instructions the agent will then follow. Exposing the install route
	// as a tool would let an agent bound to this server acquire its own future
	// instructions — and this server is reachable by agents processing scraped
	// web content and community-PR text, so a prompt-injected run could ask it
	// to install a package whose skills redirect it further. That is a
	// self-modification loop, not a convenience.
	//
	// The same reasoning the "human gates stay human" rule applies to
	// approvals: the route stays available to a human through the API, the web
	// UI and the CLI. It is only absent from the TOOL surface.
	//
	// Also excluded for the same reason: POST /:id/resync (re-fetches content
	// that may have changed since a human reviewed it) and the allowlist
	// routes (an agent must not be able to widen what it is permitted to
	// fetch). Reading is safe and useful, so it is offered.
	{
		method: 'GET',
		path: '/api/agent-plugins',
		toolName: 'list_agent_plugin_packages',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/agent-plugins/findings',
		toolName: 'list_agent_plugin_findings',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/agent-plugins/catalog',
		toolName: 'list_agent_plugin_catalog_entries',
		annotations: { readOnlyHint: true }
	},
	{
		method: 'GET',
		path: '/api/agent-plugins/updates',
		toolName: 'list_agent_plugin_updates',
		annotations: { readOnlyHint: true }
	}
];
