/**
 * Works-security (2026-10-18) — the MCP tools that stay OFF unless an
 * operator turns them on.
 *
 * The API cannot tell an MCP client holding the owner's personal key (or a
 * session JWT forwarded by this server) from the owner, and every client of
 * this server is a model that may be reading hostile content: a scraped page,
 * an email body, community-PR text, a Task description. A prompt-injected
 * client must not be able to deploy, re-point a plugin's base URL, start paid
 * runs or destroy data just because the owner's key is configured.
 *
 * Nothing is removed. `MCP_PRIVILEGED_TOOLS=true` on the MCP server registers
 * every tool below exactly as before, and restores the arguments in
 * {@link MCP_PRIVILEGED_ARGS}. With the switch off (the default) the tools are
 * not registered — the client never sees them offered — and the server logs
 * which ones it held back and why at startup.
 *
 * The labels lane and others share `whitelist.ts`; this list is kept apart on
 * purpose so the switch never needs an edit to a whitelist entry. The spec
 * pins that every name here is on the whitelist.
 */

/** The environment switch. `true` / `1` / `on` (case-insensitive) turns it on. */
export const MCP_PRIVILEGED_TOOLS_ENV = 'MCP_PRIVILEGED_TOOLS';

/** Whether the operator turned the privileged tools on. Off unless explicitly enabled. */
export function mcpPrivilegedToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[MCP_PRIVILEGED_TOOLS_ENV]?.trim().toLowerCase();
	return raw === 'true' || raw === '1' || raw === 'on';
}

/** Privileged tool name → why it is held back by default. */
export const MCP_PRIVILEGED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
	// Publishes to the internet.
	deploy_work: 'deploys the Work website',
	// Configuration that holds secrets or redirects model traffic.
	enable_plugin: 'a plugin gains account data and can become the model provider',
	update_plugin_settings: 'plugin settings hold secrets and base URLs that redirect every model call',
	// Starts autonomous / paid work.
	generate_items: 'starts paid AI generation',
	update_items: 'starts paid AI generation',
	update_schedule: 'schedules recurring autonomous runs',
	run_scheduled_update: 'starts a run',
	run_mission_now: 'starts a paid Mission tick',
	resume_mission: 'restarts scheduled Mission runs',
	// A clone starts ACTIVE with the source's cron schedule and auto-build
	// setting — a paused scheduled Mission comes back as a running one.
	clone_mission: 'the copy starts active with the source schedule and auto-build',
	build_idea: 'starts a paid build',
	retry_idea: 'starts a paid build',
	rebuild_idea: 'starts a paid build',
	accept_idea: 'closes an Idea against a Work',
	run_tasks_batch: 'starts agent runs',
	run_task: 'starts an agent run',
	activate_goal: 'starts the Goal loop',
	update_goal_limits: 'changes a spend cap and the assigned Agent',
	run_agent_now: 'starts an agent run',
	resume_agent: 'releases an agent to run on its cadence',
	process_community_prs: 'acts on pull requests (and spends)',
	// Destroys or hides data.
	delete_work: 'destructive',
	delete_mission: 'destructive',
	delete_task: 'destructive',
	discard_task_branch: 'throws away pushed work the platform cannot get back',
	delete_inbox_item: 'hides a notice from the owner',
	delete_comparison: 'destructive',
	remove_item: 'deletes an item from the Work data repository',
	// Cloud computers (FL-17) — real money on the owner's own provider account.
	fleet_cloud_create: 'creates a machine billed to the owner’s cloud provider account until destroyed',
	fleet_cloud_power: 'powers a billed cloud machine on or off',
	fleet_cloud_destroy: 'destroys a cloud machine and its disk at the provider'
});

/**
 * Arguments a tool keeps only while the switch is on: who runs a Task and
 * when. With them a client could file (or re-point) a Task straight at an
 * Agent and schedule it — a run nobody started.
 */
export const MCP_PRIVILEGED_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	create_task: Object.freeze(['agentId', 'scheduledAt']),
	update_task: Object.freeze(['agentId', 'scheduledAt']),
	// A cron `schedule` makes the Mission tick on its own, `autoBuildWorks`
	// queues every spawned Idea for a paid build, and `guardrailsOverride`
	// loosens the limits those builds run under — the same powers as the held-
	// back `update_schedule` / `resume_mission`. Without them an MCP client can
	// still file and edit a one-shot Mission; a person starts it in the app.
	create_mission: Object.freeze(['schedule', 'autoBuildWorks', 'guardrailsOverride']),
	update_mission: Object.freeze(['schedule', 'autoBuildWorks', 'guardrailsOverride'])
});

/**
 * Argument VALUES a registered tool refuses while the switch is off. The tool
 * stays useful for everything else; only the call that would start work is
 * refused, with a reason the client can act on.
 */
export interface HeldBackValueRule {
	/** The tool argument the rule reads. */
	readonly arg: string;
	/** True when this value is the privileged one. */
	readonly matches: (value: unknown) => boolean;
	/** Shown to the client (and appended to the tool description). */
	readonly reason: string;
}

/**
 * The platform's task-chat mention grammar (`MENTION_RE` in
 * `packages/agent/src/tasks-domain/task-chat.service.ts`): `@slug` anywhere,
 * no word-start requirement, so `x@builder-bot` and an e-mail address count
 * too. Case-insensitive here so an upper-case variant cannot slip past.
 * Mirrors `mentionsSomeone` in the web assistant's `privileged.ts`.
 */
const TASK_CHAT_MENTION_RE = /@([a-z0-9-]{1,80})\b/i;

/**
 * Task statuses whose move starts agent work: `→ in_progress` dispatches the
 * Task's agents, `→ in_review` dispatches its reviewers and `→ done` releases
 * dependents into the dispatch cascade. A held-back `run_task` would be one
 * `transition_task` call away without this rule. Other moves (backlog, todo,
 * blocked, cancelled and the re-opens) stay open.
 */
const DISPATCHING_TASK_STATUSES: ReadonlySet<string> = new Set(['in_progress', 'in_review', 'done']);

export const MCP_PRIVILEGED_ARG_VALUES: Readonly<Record<string, readonly HeldBackValueRule[]>> = Object.freeze({
	transition_task: Object.freeze([
		{
			arg: 'to',
			matches: (value: unknown) =>
				typeof value === 'string' && DISPATCHING_TASK_STATUSES.has(value.trim().toLowerCase()),
			reason:
				'moving a Task to in_progress, in_review or done starts agent runs (the Task agents, its reviewers, ' +
				'or its dependents); a person makes that move in the app'
		}
	]),
	post_task_chat_message: Object.freeze([
		{
			arg: 'body',
			matches: (value: unknown) => typeof value === 'string' && TASK_CHAT_MENTION_RE.test(value),
			reason:
				'an @mention in Task chat starts the mentioned Agent; write names without the @ (an e-mail address ' +
				'counts as a mention too)'
		}
	])
});

/**
 * Why this call is refused while the switch is off, or `null` when it may run.
 * Only the arguments the client actually sent are read.
 */
export function heldBackValueRefusal(toolName: string, args: Record<string, unknown>, enabled: boolean): string | null {
	if (enabled || !Object.prototype.hasOwnProperty.call(MCP_PRIVILEGED_ARG_VALUES, toolName)) return null;
	for (const rule of MCP_PRIVILEGED_ARG_VALUES[toolName]) {
		if (!Object.prototype.hasOwnProperty.call(args, rule.arg)) continue;
		if (rule.matches(args[rule.arg])) {
			return (
				`Refused: ${rule.reason}. This MCP server holds that call back unless the operator sets ` +
				`${MCP_PRIVILEGED_TOOLS_ENV}=true.`
			);
		}
	}
	return null;
}

/** The note appended to a tool description while its value rules apply, or `''`. */
export function heldBackValueNote(toolName: string, enabled: boolean): string {
	if (enabled || !Object.prototype.hasOwnProperty.call(MCP_PRIVILEGED_ARG_VALUES, toolName)) return '';
	const reasons = MCP_PRIVILEGED_ARG_VALUES[toolName].map((rule) => rule.reason);
	return ` Not available through this server unless ${MCP_PRIVILEGED_TOOLS_ENV}=true: ${reasons.join('; ')}.`;
}

/** True when `toolName` is privileged and the switch is off. */
export function isHeldBack(toolName: string, enabled: boolean): boolean {
	return !enabled && Object.prototype.hasOwnProperty.call(MCP_PRIVILEGED_TOOLS, toolName);
}

/** The privileged arguments `toolName` loses while the switch is off. */
export function heldBackArgs(toolName: string, enabled: boolean): readonly string[] {
	if (enabled) return [];
	return Object.prototype.hasOwnProperty.call(MCP_PRIVILEGED_ARGS, toolName) ? MCP_PRIVILEGED_ARGS[toolName] : [];
}
