import type { Agent } from '../entities/agent.entity';
import type { TasksService } from './tasks.service';
import type { TaskChatService } from './task-chat.service';
import type { TaskStatus } from '../entities/task.entity';

/**
 * Tasks feature — Phase 16.2 / 16.3 / 16.4.
 *
 * Tool descriptors that wrap the platform's Task surface so an
 * Agent can act on Tasks during a run. Built here (in tasks-domain)
 * instead of in `agent-tool.service` to avoid pulling the Tasks
 * graph into the agents subpath — `AiFacadeService.assembleTools()`
 * concatenates the two lists at run time.
 *
 * Permission gating:
 *   - createTask       → permissions.canAssignTasks
 *   - commentOnTask    → always allowed (commenting is communication,
 *                        not delegation; falls under the basic
 *                        chat-thread participation any Agent has on
 *                        Tasks it can see)
 *   - transitionTask   → always allowed when the Agent is an
 *                        assignee/reviewer/approver — the
 *                        TaskTransitionService still enforces the
 *                        state-machine + blocker/approver gates
 */

export interface TaskToolDescriptor<TArgs = unknown, TResult = unknown> {
	name: string;
	description: string;
	parameters: {
		type: 'object';
		properties: Record<string, { type: string; description: string }>;
		required: string[];
	};
	invoke: (args: TArgs) => Promise<TResult | { error: string }>;
}

export interface CreateTaskArgs {
	title: string;
	description?: string;
	priority?: string;
	missionId?: string | null;
	ideaId?: string | null;
	workId?: string | null;
	parentTaskId?: string | null;
}

export interface CommentOnTaskArgs {
	taskId: string;
	body: string;
}

export interface TransitionTaskArgs {
	taskId: string;
	to: TaskStatus;
	force?: boolean;
}

export function buildAgentTaskTools(args: {
	agent: Agent;
	tasksService: TasksService;
	chatService: TaskChatService;
}): TaskToolDescriptor[] {
	const out: TaskToolDescriptor[] = [];

	if (args.agent.permissions?.canAssignTasks) {
		out.push({
			name: 'createTask',
			description:
				'Create a new Task. The Task is scoped to the same Mission/Idea/Work the Agent is in (or unscoped if the Agent is tenant-scoped). Returns the new Task slug + id.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Short title (≤200 chars).' },
					description: { type: 'string', description: 'Optional Markdown body.' },
					priority: {
						type: 'string',
						description: 'p0 / p1 / p2 / p3 (default) / p4.',
					},
					parentTaskId: {
						type: 'string',
						description: 'Optional parent task id to nest under.',
					},
				},
				required: ['title'],
			},
			invoke: async (raw) => {
				const a = raw as CreateTaskArgs;
				try {
					const created = await args.tasksService.create(args.agent.userId, {
						title: a.title,
						description: a.description ?? null,
						priority: a.priority as any,
						missionId: args.agent.missionId ?? null,
						ideaId: args.agent.ideaId ?? null,
						workId: args.agent.workId ?? null,
						parentTaskId: a.parentTaskId ?? null,
						createdByType: 'agent',
						createdById: args.agent.id,
					});
					return { id: created.id, slug: created.slug };
				} catch (err) {
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
		} satisfies TaskToolDescriptor<CreateTaskArgs, { id: string; slug: string }>);
	}

	out.push({
		name: 'commentOnTask',
		description:
			'Post a chat message on a Task. The body is secret-scanned + size-capped. Use @<slug> mentions to ping other Agents/users; [[kb-slug]] to reference KB docs. Unknown mentions are stripped server-side.',
		parameters: {
			type: 'object',
			properties: {
				taskId: { type: 'string', description: 'The Task UUID.' },
				body: { type: 'string', description: 'Message body (≤16 KB).' },
			},
			required: ['taskId', 'body'],
		},
		invoke: async (raw) => {
			const a = raw as CommentOnTaskArgs;
			if (!a?.taskId || !a?.body) return { error: 'taskId and body are required' };
			try {
				const message = await args.chatService.post(
					args.agent.userId,
					{
						taskId: a.taskId,
						authorType: 'agent',
						authorId: args.agent.id,
						body: a.body,
					},
					{},
				);
				return { id: message.id, createdAt: message.createdAt.toISOString() };
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) };
			}
		},
	} satisfies TaskToolDescriptor<CommentOnTaskArgs, { id: string; createdAt: string }>);

	out.push({
		name: 'transitionTask',
		description:
			'Move a Task to a new status. The state-machine enforces legal transitions; → done requires no open blockers AND (when requireAllApprovers=true) all approvers must have approved.',
		parameters: {
			type: 'object',
			properties: {
				taskId: { type: 'string', description: 'The Task UUID.' },
				to: {
					type: 'string',
					description:
						'Target status: backlog / todo / in_progress / in_review / blocked / done / cancelled.',
				},
				force: { type: 'string', description: '"true" to override the approver gate (NOT blocker gate).' },
			},
			required: ['taskId', 'to'],
		},
		invoke: async (raw) => {
			const a = raw as TransitionTaskArgs;
			if (!a?.taskId || !a?.to) return { error: 'taskId and to are required' };
			try {
				const updated = await args.tasksService.transition(args.agent.userId, a.taskId, a.to, {
					force: a.force === true || (a.force as any) === 'true',
				});
				return { id: updated.id, status: updated.status };
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) };
			}
		},
	} satisfies TaskToolDescriptor<TransitionTaskArgs, { id: string; status: TaskStatus }>);

	return out;
}
