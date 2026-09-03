import { describe, expect, it } from 'vitest';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';

/**
 * Self-build program (EW-762 / EW-769) — pins the MCP surface for the
 * work-orchestration domains so an external agent can drive Tasks,
 * answer the Inbox, steer Goals and Agents and watch the Fleet. The tool
 * name + (method, path) tuple is what MCP clients bind to; a typo here
 * is silently breaking, so the whole set is spelled out.
 *
 * Spec-references (route sources):
 *   - Tasks:  `apps/api/src/tasks/tasks.controller.ts` (`/api/tasks`)
 *   - Inbox:  `apps/api/src/inbox/inbox.controller.ts` (`/api/inbox`)
 *   - Goals:  `apps/api/src/goals/goals.controller.ts` (`/api/me/goals`)
 *   - Fleet:  `apps/api/src/fleet/fleet.controller.ts` (`/api/fleet`) and
 *             `fleet-agent-affinity.controller.ts` (`/api/fleet/agents`)
 *   - Agents: `apps/api/src/agents/agents.controller.ts` (`/api/agents`)
 */

type Entry = { method: string; path: string; toolName: string };

const TASK_ENTRIES: Entry[] = [
	{ method: 'GET', path: '/api/tasks', toolName: 'list_tasks' },
	{ method: 'POST', path: '/api/tasks', toolName: 'create_task' },
	{ method: 'POST', path: '/api/tasks/run-batch', toolName: 'run_tasks_batch' },
	{ method: 'GET', path: '/api/tasks/{id}', toolName: 'get_task' },
	{ method: 'PATCH', path: '/api/tasks/{id}', toolName: 'update_task' },
	{ method: 'DELETE', path: '/api/tasks/{id}', toolName: 'delete_task' },
	{ method: 'GET', path: '/api/tasks/{id}/subtasks', toolName: 'list_task_subtasks' },
	{ method: 'GET', path: '/api/tasks/{id}/activity', toolName: 'get_task_activity' },
	{ method: 'POST', path: '/api/tasks/{id}/transition', toolName: 'transition_task' },
	{ method: 'GET', path: '/api/tasks/{id}/run-candidates', toolName: 'get_task_run_candidates' },
	{ method: 'POST', path: '/api/tasks/{id}/run', toolName: 'run_task' },
	{ method: 'GET', path: '/api/tasks/{id}/pr-status', toolName: 'get_task_pr_status' },
	{ method: 'GET', path: '/api/tasks/{id}/diff', toolName: 'get_task_diff' },
	{ method: 'POST', path: '/api/tasks/{id}/discard-branch', toolName: 'discard_task_branch' },
	{ method: 'POST', path: '/api/tasks/{id}/reject', toolName: 'reject_task' },
	{ method: 'POST', path: '/api/tasks/{id}/assignees', toolName: 'assign_task' },
	{ method: 'POST', path: '/api/tasks/{id}/reviewers', toolName: 'add_task_reviewer' },
	{ method: 'POST', path: '/api/tasks/{id}/approvers', toolName: 'add_task_approver' },
	{ method: 'POST', path: '/api/tasks/{id}/relations', toolName: 'add_task_relation' },
	{ method: 'GET', path: '/api/tasks/{id}/escalations', toolName: 'list_task_escalations' },
	{
		method: 'POST',
		path: '/api/tasks/{id}/escalations/{escalationId}/resolve',
		toolName: 'resolve_task_escalation'
	},
	{ method: 'GET', path: '/api/tasks/{id}/chat', toolName: 'get_task_chat' },
	{ method: 'POST', path: '/api/tasks/{id}/chat', toolName: 'post_task_chat_message' },
	{ method: 'GET', path: '/api/tasks/{id}/spend', toolName: 'get_task_spend' }
];

const INBOX_ENTRIES: Entry[] = [
	{ method: 'GET', path: '/api/inbox', toolName: 'list_inbox' },
	{ method: 'GET', path: '/api/inbox/unread-count', toolName: 'get_inbox_unread_count' },
	{ method: 'GET', path: '/api/inbox/{id}', toolName: 'get_inbox_item' },
	{ method: 'POST', path: '/api/inbox/{id}/reply', toolName: 'reply_inbox_item' },
	{ method: 'PATCH', path: '/api/inbox/{id}/read', toolName: 'mark_inbox_item_read' },
	{ method: 'POST', path: '/api/inbox/{id}/archive', toolName: 'archive_inbox_item' },
	{ method: 'POST', path: '/api/inbox/{id}/unarchive', toolName: 'unarchive_inbox_item' },
	{ method: 'DELETE', path: '/api/inbox/{id}', toolName: 'delete_inbox_item' }
];

const GOAL_ENTRIES: Entry[] = [
	{ method: 'GET', path: '/api/me/goals', toolName: 'list_goals' },
	{ method: 'POST', path: '/api/me/goals', toolName: 'create_goal' },
	{ method: 'GET', path: '/api/me/goals/{id}', toolName: 'get_goal' },
	{ method: 'PATCH', path: '/api/me/goals/{id}', toolName: 'update_goal' },
	{ method: 'GET', path: '/api/me/goals/{id}/samples', toolName: 'get_goal_samples' },
	{ method: 'POST', path: '/api/me/goals/{id}/activate', toolName: 'activate_goal' },
	{ method: 'POST', path: '/api/me/goals/{id}/pause', toolName: 'pause_goal' },
	{ method: 'POST', path: '/api/me/goals/{id}/evaluate-now', toolName: 'evaluate_goal_now' },
	{ method: 'PATCH', path: '/api/me/goals/{id}/limits', toolName: 'update_goal_limits' },
	{ method: 'POST', path: '/api/me/goals/{id}/dod/propose', toolName: 'propose_goal_dod' },
	{ method: 'POST', path: '/api/me/goals/{id}/dod/approve', toolName: 'approve_goal_dod' }
];

const FLEET_ENTRIES: Entry[] = [
	{ method: 'GET', path: '/api/fleet/nodes', toolName: 'list_fleet_nodes' },
	{ method: 'GET', path: '/api/fleet/nodes/{id}', toolName: 'get_fleet_node' },
	{ method: 'GET', path: '/api/fleet/runner-status', toolName: 'get_fleet_runner_status' },
	{
		method: 'GET',
		path: '/api/fleet/execution-preferences',
		toolName: 'get_fleet_execution_preferences'
	},
	{
		method: 'GET',
		path: '/api/fleet/agents/{agentId}/node-affinity',
		toolName: 'get_agent_node_affinity'
	},
	{
		method: 'PUT',
		path: '/api/fleet/agents/{agentId}/node-affinity',
		toolName: 'set_agent_node_affinity'
	},
	{
		method: 'DELETE',
		path: '/api/fleet/agents/{agentId}/node-affinity',
		toolName: 'clear_agent_node_affinity'
	},
	{ method: 'POST', path: '/api/fleet/nodes/{id}/drain', toolName: 'drain_fleet_node' }
];

const AGENT_ENTRIES: Entry[] = [
	{ method: 'GET', path: '/api/agents', toolName: 'list_agents' },
	{ method: 'GET', path: '/api/agents/{id}', toolName: 'get_agent' },
	{ method: 'GET', path: '/api/agents/{id}/runs', toolName: 'list_agent_runs' },
	{ method: 'GET', path: '/api/agents/{id}/runs/{runId}', toolName: 'get_agent_run' },
	{ method: 'POST', path: '/api/agents/{id}/run-now', toolName: 'run_agent_now' },
	{ method: 'POST', path: '/api/agents/{id}/runs/{runId}/cancel', toolName: 'cancel_agent_run' },
	{ method: 'POST', path: '/api/agents/{id}/pause', toolName: 'pause_agent' },
	{ method: 'POST', path: '/api/agents/{id}/resume', toolName: 'resume_agent' },
	{ method: 'GET', path: '/api/agents/{id}/budget', toolName: 'get_agent_budget' }
];

const ALL: Entry[] = [...TASK_ENTRIES, ...INBOX_ENTRIES, ...GOAL_ENTRIES, ...FLEET_ENTRIES, ...AGENT_ENTRIES];

/** Routes the API itself treats as node-credential or secret-bearing; they must never become tools. */
const FORBIDDEN_PATHS = [
	'/api/fleet/enroll',
	'/api/fleet/heartbeat',
	'/api/fleet/pause',
	'/api/fleet/unenroll',
	'/api/fleet/jobs/lease',
	'/api/fleet/jobs/{id}/heartbeat',
	'/api/fleet/jobs/{id}/complete',
	'/api/fleet/enrollment-tokens',
	'/api/fleet/nodes/enrollment-token',
	'/api/fleet/nodes/{id}/rotate'
];

const DESTRUCTIVE = ['delete_task', 'discard_task_branch', 'delete_inbox_item', 'clear_agent_node_affinity'];

function find(entry: Entry) {
	return WHITELIST.find((w) => w.method === entry.method && w.path === entry.path);
}

describe('WHITELIST — self-build program (Tasks / Inbox / Goals / Fleet / Agents)', () => {
	it('exposes every Task, Inbox, Goal, Fleet and Agent entry under its intended tool name', () => {
		for (const entry of ALL) {
			const found = find(entry);
			expect(found, `${entry.method} ${entry.path}`).toBeDefined();
			expect(found?.toolName, `${entry.method} ${entry.path}`).toBe(entry.toolName);
		}
	});

	it('counts each domain', () => {
		expect(TASK_ENTRIES).toHaveLength(24);
		expect(INBOX_ENTRIES).toHaveLength(8);
		expect(GOAL_ENTRIES).toHaveLength(11);
		expect(FLEET_ENTRIES).toHaveLength(8);
		expect(AGENT_ENTRIES).toHaveLength(9);
	});

	it('annotates every GET as read-only and nothing else as read-only', () => {
		for (const entry of ALL) {
			const found = find(entry)!;
			if (entry.method === 'GET') {
				expect(found.annotations?.readOnlyHint, entry.toolName).toBe(true);
			} else {
				expect(found.annotations?.readOnlyHint, entry.toolName).toBeUndefined();
			}
		}
	});

	it('flags the irreversible calls as destructive and nothing else', () => {
		for (const entry of ALL) {
			const found = find(entry)!;
			if (DESTRUCTIVE.includes(entry.toolName)) {
				expect(found.annotations?.destructiveHint, entry.toolName).toBe(true);
			} else {
				expect(found.annotations?.destructiveHint, entry.toolName).toBeUndefined();
			}
		}
	});

	it('keeps node-credential and token routes out of the tool surface', () => {
		for (const path of FORBIDDEN_PATHS) {
			expect(
				WHITELIST.find((w) => w.path === path),
				path
			).toBeUndefined();
		}
	});

	it('uses OpenAPI-style path templates matching the Nest route parameters', () => {
		for (const entry of ALL) {
			expect(entry.path, entry.toolName).not.toMatch(/:[a-zA-Z]/);
			expect(entry.path, entry.toolName).toMatch(/^\/api\//);
		}
		expect(
			find({ method: 'POST', path: '/api/tasks/{id}/escalations/{escalationId}/resolve', toolName: '' })
		).toBeDefined();
		expect(find({ method: 'POST', path: '/api/agents/{id}/runs/{runId}/cancel', toolName: '' })).toBeDefined();
	});

	it('all tool names are unique across the entire whitelist (no shadowing)', () => {
		const names = WHITELIST.map((w) => w.toolName).filter((n): n is string => typeof n === 'string');
		expect(new Set(names).size).toBe(names.length);
		const tuples = WHITELIST.map((w) => `${w.method} ${w.path}`);
		expect(new Set(tuples).size).toBe(tuples.length);
	});
});
