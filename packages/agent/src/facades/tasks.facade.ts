import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
	ExternalChatDto,
	ExternalChatPostInput,
	ExternalTaskCreateInput,
	ExternalTaskDto,
	ExternalTaskListFilter,
	ExternalTaskUpdatePatch,
	FacadeOptions,
	ITaskTrackerPlugin,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { BaseFacadeService, FacadeError } from './base.facade';

export class TasksFacadeError extends FacadeError {
	constructor(message: string, operation: string, provider?: string, cause?: Error) {
		super(message, operation, provider, cause);
		this.name = 'TasksFacadeError';
	}
}

/**
 * Tasks feature — Phase 11.8 (ADR-013).
 *
 * Resolves the active `task-tracker` plugin for the user/work scope
 * and forwards every Task operation through it. v1 of the platform
 * ships with "Ever Works Task Tracker" as the default; community
 * plugins (Linear / Jira / GitHub Issues) drop in by implementing
 * `ITaskTrackerPlugin`.
 *
 * Only one provider is active per resolution scope — unlike
 * SkillsFacadeService which unions across all enabled providers,
 * the Task surface forwards to exactly one provider so the UI's
 * single source of truth stays coherent (a Task can't simultaneously
 * live in two trackers).
 */
@Injectable()
export class TasksFacadeService extends BaseFacadeService {
	protected readonly logger = new Logger(TasksFacadeService.name);
	protected readonly CAPABILITY = PLUGIN_CAPABILITIES.TASK_TRACKER;

	constructor(
		registry: PluginRegistryService,
		settingsService: PluginSettingsService,
		@Optional() workPluginRepository?: WorkPluginRepository,
	) {
		super(registry, settingsService, workPluginRepository);
	}

	private async resolveTracker(facadeOptions: FacadeOptions): Promise<ITaskTrackerPlugin> {
		return this.resolvePlugin<ITaskTrackerPlugin>(
			facadeOptions.providerOverride,
			facadeOptions.userId,
			facadeOptions.workId,
		);
	}

	async listTasks(
		filter: ExternalTaskListFilter,
		facadeOptions: FacadeOptions,
	): Promise<{ tasks: ExternalTaskDto[]; total: number }> {
		const plugin = await this.resolveTracker(facadeOptions);
		const settings = await this.resolveSettings(plugin.id, facadeOptions);
		return plugin.listTasks(filter, settings);
	}

	async getTask(id: string, facadeOptions: FacadeOptions): Promise<ExternalTaskDto | null> {
		const plugin = await this.resolveTracker(facadeOptions);
		const settings = await this.resolveSettings(plugin.id, facadeOptions);
		return plugin.getTask(id, settings);
	}

	async createTask(
		input: ExternalTaskCreateInput,
		facadeOptions: FacadeOptions,
	): Promise<ExternalTaskDto> {
		const plugin = await this.resolveTracker(facadeOptions);
		const settings = await this.resolveSettings(plugin.id, facadeOptions);
		return plugin.createTask(input, settings);
	}

	async updateTask(
		id: string,
		patch: ExternalTaskUpdatePatch,
		facadeOptions: FacadeOptions,
	): Promise<ExternalTaskDto> {
		const plugin = await this.resolveTracker(facadeOptions);
		const settings = await this.resolveSettings(plugin.id, facadeOptions);
		return plugin.updateTask(id, patch, settings);
	}

	async deleteTask(id: string, facadeOptions: FacadeOptions): Promise<void> {
		const plugin = await this.resolveTracker(facadeOptions);
		const settings = await this.resolveSettings(plugin.id, facadeOptions);
		return plugin.deleteTask(id, settings);
	}

	async listChat(
		taskId: string,
		opts: { limit?: number; cursor?: string },
		facadeOptions: FacadeOptions,
	): Promise<{ messages: ExternalChatDto[]; nextCursor?: string }> {
		const plugin = await this.resolveTracker(facadeOptions);
		const settings = await this.resolveSettings(plugin.id, facadeOptions);
		return plugin.listChat(taskId, opts, settings);
	}

	async postChat(
		input: ExternalChatPostInput,
		facadeOptions: FacadeOptions,
	): Promise<ExternalChatDto> {
		const plugin = await this.resolveTracker(facadeOptions);
		const settings = await this.resolveSettings(plugin.id, facadeOptions);
		return plugin.postChat(input, settings);
	}

	private async resolveSettings(
		pluginId: string,
		facadeOptions: FacadeOptions,
	): Promise<Record<string, unknown> | undefined> {
		if (!this.settingsService) return undefined;
		try {
			return await this.settingsService.resolveSettings(pluginId, facadeOptions);
		} catch {
			return undefined;
		}
	}
}
