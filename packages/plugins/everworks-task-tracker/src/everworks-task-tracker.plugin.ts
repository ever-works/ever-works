import type {
	ExternalChatDto,
	ExternalChatPostInput,
	ExternalTaskCreateInput,
	ExternalTaskDto,
	ExternalTaskListFilter,
	ExternalTaskUpdatePatch,
	IPlugin,
	ITaskTrackerPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginSettings
} from '@ever-works/plugin';

/**
 * Ever Works Task Tracker — first-party `task-tracker` plugin
 * (ADR-013).
 *
 * Unlike most plugins, this one does NOT call out to an external
 * service. It is a thin shim whose v1 implementation forwards
 * every call to the platform's own DB-backed Task service via a
 * runtime-injected delegate (`PlatformTaskBackend`). Wiring lives
 * in the platform's TasksModule which provides the delegate
 * during plugin bootstrap.
 *
 * The shape exists so the platform's UI can route every Task
 * operation through `TasksFacadeService.resolvePlugin('task-tracker')`
 * — installing a different plugin (e.g. "Linear Tasks") swaps the
 * back-end without changing the UI.
 *
 * When the delegate is not yet bound (rare — only in tests), every
 * method returns an empty/no-op result so the plugin registry can
 * still load it without crashing.
 */

export interface PlatformTaskBackend {
	listTasks(filter: ExternalTaskListFilter): Promise<{ tasks: ExternalTaskDto[]; total: number }>;
	getTask(id: string): Promise<ExternalTaskDto | null>;
	createTask(input: ExternalTaskCreateInput): Promise<ExternalTaskDto>;
	updateTask(id: string, patch: ExternalTaskUpdatePatch): Promise<ExternalTaskDto>;
	deleteTask(id: string): Promise<void>;
	listChat(
		taskId: string,
		opts: { limit?: number; cursor?: string }
	): Promise<{ messages: ExternalChatDto[]; nextCursor?: string }>;
	postChat(input: ExternalChatPostInput): Promise<ExternalChatDto>;
}

let installedBackend: PlatformTaskBackend | null = null;
/**
 * Module-level setter so the platform's TasksModule can bind the
 * real DB-backed service into this plugin without going through
 * NestJS DI inside the plugin sandbox.
 */
export function setPlatformTaskBackend(backend: PlatformTaskBackend | null): void {
	installedBackend = backend;
}

const NOOP_LIST = { tasks: [] as ExternalTaskDto[], total: 0 };
const NOOP_CHAT = { messages: [] as ExternalChatDto[] };

export class EverWorksTaskTrackerPlugin implements IPlugin, ITaskTrackerPlugin {
	readonly id = 'everworks-task-tracker';
	readonly name = 'Ever Works Task Tracker';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility' as PluginCategory;
	readonly capabilities: readonly string[] = ['task-tracker'];
	readonly providerName = 'Ever Works Task Tracker';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {}
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'admin-only';

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Ever Works Task Tracker plugin loaded (DB-backed first-party provider).');
	}

	async onUnload(): Promise<void> {
		// Platform stays alive; just forget the binding.
		setPlatformTaskBackend(null);
	}

	isAvailable(_settings?: PluginSettings): boolean {
		return installedBackend !== null;
	}

	async listTasks(filter: ExternalTaskListFilter): Promise<{ tasks: ExternalTaskDto[]; total: number }> {
		if (!installedBackend) return NOOP_LIST;
		return installedBackend.listTasks(filter);
	}

	async getTask(id: string): Promise<ExternalTaskDto | null> {
		if (!installedBackend) return null;
		return installedBackend.getTask(id);
	}

	async createTask(input: ExternalTaskCreateInput): Promise<ExternalTaskDto> {
		if (!installedBackend) {
			throw new Error('Task backend not bound — no platform Tasks DB is available.');
		}
		return installedBackend.createTask(input);
	}

	async updateTask(id: string, patch: ExternalTaskUpdatePatch): Promise<ExternalTaskDto> {
		if (!installedBackend) {
			throw new Error('Task backend not bound — no platform Tasks DB is available.');
		}
		return installedBackend.updateTask(id, patch);
	}

	async deleteTask(id: string): Promise<void> {
		if (!installedBackend) return;
		return installedBackend.deleteTask(id);
	}

	async listChat(
		taskId: string,
		opts: { limit?: number; cursor?: string }
	): Promise<{ messages: ExternalChatDto[]; nextCursor?: string }> {
		if (!installedBackend) return NOOP_CHAT;
		return installedBackend.listChat(taskId, opts);
	}

	async postChat(input: ExternalChatPostInput): Promise<ExternalChatDto> {
		if (!installedBackend) {
			throw new Error('Task backend not bound — no platform Tasks DB is available.');
		}
		return installedBackend.postChat(input);
	}
}
