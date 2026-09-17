/**
 * Shared view — the activity kinds the published strip may show.
 *
 * CLOSED BY DEFAULT: an activity kind is published only when it is named
 * here. A newly added kind stays off the published page until somebody adds
 * it deliberately; the agent-side classification spec fails until every kind
 * is on this list or on the never-publish list.
 *
 * Each entry is safe because its Live Feed narration reads nothing beyond a
 * Task title (already on a published card) or a status token: no path, no
 * repository, no Work name, no amount, no error text, no person.
 */
export const PUBLISHABLE_ACTIVITY_ACTIONS: readonly string[] = Object.freeze([
	'task_created',
	'task_transitioned',
	'task_completed',
	'task_assigned',
	'agent_task_assigned',
	'agent_run_started',
	'agent_run_completed',
	'agent_paused',
	'agent_resumed'
]);

export function isPublishableActivityAction(actionType: unknown): boolean {
	return typeof actionType === 'string' && PUBLISHABLE_ACTIVITY_ACTIONS.includes(actionType);
}
