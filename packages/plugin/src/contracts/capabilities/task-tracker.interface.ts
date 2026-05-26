import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Tasks feature — Phase 11.6 (ADR-013).
 *
 * Capability contract for external task trackers. Lets future
 * community plugins surface tasks from Linear / Jira / Github
 * Issues / etc. into the platform without re-implementing the
 * platform's own Task UI.
 *
 * v1 of the platform ships its own "Ever Works Task Tracker"
 * plugin as the first-party implementation (Phase 11.7). The
 * platform's TasksFacadeService routes through the enabled
 * `task-tracker` provider — installing a different plugin swaps
 * the back-end without changing the UI.
 *
 * Capability id: `'task-tracker'`.
 */

export type ExternalTaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';

export type ExternalTaskPriority = 'p0' | 'p1' | 'p2' | 'p3' | 'p4';

export type ExternalTaskActorType = 'user' | 'agent';

export interface ExternalTaskActorRef {
	type: ExternalTaskActorType;
	id: string;
}

export interface ExternalTaskDto {
	id: string;
	slug: string;
	title: string;
	description?: string | null;
	status: ExternalTaskStatus;
	priority: ExternalTaskPriority;
	labels?: string[] | null;
	scope: {
		missionId?: string | null;
		ideaId?: string | null;
		workId?: string | null;
	};
	parentTaskId?: string | null;
	assignees: ExternalTaskActorRef[];
	reviewers: ExternalTaskActorRef[];
	approvers: ExternalTaskActorRef[];
	createdBy: ExternalTaskActorRef;
	createdAt: string;
	updatedAt: string;
	startedAt?: string | null;
	completedAt?: string | null;
}

export interface ExternalChatDto {
	id: string;
	taskId: string;
	author: ExternalTaskActorRef;
	body: string;
	createdAt: string;
	editedAt?: string | null;
}

export interface ExternalTaskListFilter {
	status?: ExternalTaskStatus | ExternalTaskStatus[];
	priority?: ExternalTaskPriority | ExternalTaskPriority[];
	missionId?: string;
	ideaId?: string;
	workId?: string;
	assigneeId?: string;
	parentTaskId?: string;
	search?: string;
	limit?: number;
	offset?: number;
}

export interface ExternalTaskCreateInput {
	title: string;
	description?: string;
	status?: ExternalTaskStatus;
	priority?: ExternalTaskPriority;
	labels?: string[];
	missionId?: string | null;
	ideaId?: string | null;
	workId?: string | null;
	parentTaskId?: string | null;
	assignees?: ExternalTaskActorRef[];
	reviewers?: ExternalTaskActorRef[];
	approvers?: ExternalTaskActorRef[];
	createdBy: ExternalTaskActorRef;
}

export interface ExternalTaskUpdatePatch {
	title?: string;
	description?: string | null;
	status?: ExternalTaskStatus;
	priority?: ExternalTaskPriority;
	labels?: string[] | null;
	parentTaskId?: string | null;
}

export interface ExternalChatPostInput {
	taskId: string;
	author: ExternalTaskActorRef;
	body: string;
}

export interface ITaskTrackerPlugin extends IPlugin {
	readonly providerName: string;

	listTasks(
		filter: ExternalTaskListFilter,
		settings?: PluginSettings
	): Promise<{
		tasks: ExternalTaskDto[];
		total: number;
	}>;
	getTask(id: string, settings?: PluginSettings): Promise<ExternalTaskDto | null>;
	createTask(input: ExternalTaskCreateInput, settings?: PluginSettings): Promise<ExternalTaskDto>;
	updateTask(id: string, patch: ExternalTaskUpdatePatch, settings?: PluginSettings): Promise<ExternalTaskDto>;
	deleteTask(id: string, settings?: PluginSettings): Promise<void>;

	listChat(
		taskId: string,
		opts: { limit?: number; cursor?: string },
		settings?: PluginSettings
	): Promise<{ messages: ExternalChatDto[]; nextCursor?: string }>;
	postChat(input: ExternalChatPostInput, settings?: PluginSettings): Promise<ExternalChatDto>;

	isAvailable?(settings?: PluginSettings): boolean;
}

export function isTaskTrackerPlugin(plugin: IPlugin): plugin is ITaskTrackerPlugin {
	return plugin.capabilities.includes('task-tracker');
}
