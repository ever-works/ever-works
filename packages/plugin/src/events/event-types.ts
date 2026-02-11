import type { ItemData, Category, Tag, Brand } from '@ever-works/contracts';

/**
 * Plugin lifecycle event names
 */
export type PluginLifecycleEvent =
	| 'plugin:loaded'
	| 'plugin:enabled'
	| 'plugin:disabled'
	| 'plugin:unloaded'
	| 'plugin:error'
	| 'plugin:settings-changed';

/**
 * Directory-related event names
 */
export type DirectoryEvent =
	| 'directory:created'
	| 'directory:updated'
	| 'directory:deleted'
	| 'directory:deployed'
	| 'directory:generation-started'
	| 'directory:generation-completed'
	| 'directory:generation-failed';

/**
 * Item-related event names
 */
export type ItemEvent = 'item:created' | 'item:updated' | 'item:deleted' | 'item:extracted' | 'item:validated';

/**
 * Pipeline-related event names
 */
export type PipelineEvent =
	| 'pipeline:started'
	| 'pipeline:step-started'
	| 'pipeline:step-completed'
	| 'pipeline:step-failed'
	| 'pipeline:completed'
	| 'pipeline:failed'
	| 'pipeline:cancelled';

/**
 * System event names
 */
export type SystemEvent = 'system:startup' | 'system:shutdown' | 'system:health-check';

/**
 * All plugin event names
 */
export type PluginEventName = PluginLifecycleEvent | DirectoryEvent | ItemEvent | PipelineEvent | SystemEvent;

/**
 * Base event payload interface
 */
export interface BaseEventPayload {
	/** Timestamp of the event */
	readonly timestamp: string;
	/** Optional correlation ID for tracing */
	readonly correlationId?: string;
}

/**
 * Plugin lifecycle event payloads
 */
export interface PluginLoadedPayload extends BaseEventPayload {
	readonly pluginId: string;
	readonly version: string;
}

export interface PluginErrorPayload extends BaseEventPayload {
	readonly pluginId: string;
	readonly error: Error | string;
	readonly context?: Record<string, unknown>;
}

export interface PluginSettingsChangedPayload extends BaseEventPayload {
	readonly pluginId: string;
	readonly changedKeys: readonly string[];
	readonly scope: 'global' | 'directory' | 'user';
	/** Whether any changed settings require plugin restart */
	readonly requiresRestart?: boolean;
	/** User ID when scope is 'user' */
	readonly userId?: string;
	/** Directory ID when scope is 'directory' */
	readonly directoryId?: string;
}

/**
 * Directory event payloads
 */
export interface DirectoryEventPayload extends BaseEventPayload {
	readonly directoryId: string;
	readonly directoryName?: string;
}

export interface DirectoryGenerationStartedPayload extends DirectoryEventPayload {
	readonly itemCount?: number;
	readonly options?: Record<string, unknown>;
}

export interface DirectoryGenerationCompletedPayload extends DirectoryEventPayload {
	readonly itemsGenerated: number;
	readonly categoriesGenerated: number;
	readonly tagsGenerated: number;
	readonly duration: number;
}

export interface DirectoryGenerationFailedPayload extends DirectoryEventPayload {
	readonly error: Error | string;
	readonly step?: string;
}

/**
 * Item event payloads
 */
export interface ItemEventPayload extends BaseEventPayload {
	readonly directoryId: string;
	readonly itemId?: string;
	readonly item: ItemData;
}

export interface ItemValidatedPayload extends ItemEventPayload {
	readonly valid: boolean;
	readonly errors?: readonly string[];
}

/**
 * Pipeline event payloads
 */
export interface PipelineEventPayload extends BaseEventPayload {
	readonly directoryId: string;
	readonly pipelineId?: string;
}

export interface PipelineStepEventPayload extends PipelineEventPayload {
	readonly stepId: string;
	readonly stepName: string;
	readonly stepIndex: number;
	readonly totalSteps: number;
}

export interface PipelineStepCompletedPayload extends PipelineStepEventPayload {
	readonly duration: number;
	readonly result?: Record<string, unknown>;
}

export interface PipelineStepFailedPayload extends PipelineStepEventPayload {
	readonly error: Error | string;
	readonly recoverable: boolean;
}

export interface PipelineCompletedPayload extends PipelineEventPayload {
	readonly duration: number;
	readonly stepsCompleted: number;
	readonly items: readonly ItemData[];
	readonly categories: readonly Category[];
	readonly tags: readonly Tag[];
	readonly brands: readonly Brand[];
}

export interface PipelineFailedPayload extends PipelineEventPayload {
	readonly error: Error | string;
	readonly failedStep?: string;
	readonly completedSteps: number;
}

/**
 * System event payloads
 */
export interface SystemEventPayload extends BaseEventPayload {
	readonly environment?: string;
}

/**
 * Mapped event payloads by event name
 */
export interface PluginEventPayloads {
	// Plugin lifecycle
	'plugin:loaded': PluginLoadedPayload;
	'plugin:enabled': PluginLoadedPayload;
	'plugin:disabled': PluginLoadedPayload;
	'plugin:unloaded': PluginLoadedPayload;
	'plugin:error': PluginErrorPayload;
	'plugin:settings-changed': PluginSettingsChangedPayload;

	// Directory events
	'directory:created': DirectoryEventPayload;
	'directory:updated': DirectoryEventPayload;
	'directory:deleted': DirectoryEventPayload;
	'directory:deployed': DirectoryEventPayload;
	'directory:generation-started': DirectoryGenerationStartedPayload;
	'directory:generation-completed': DirectoryGenerationCompletedPayload;
	'directory:generation-failed': DirectoryGenerationFailedPayload;

	// Item events
	'item:created': ItemEventPayload;
	'item:updated': ItemEventPayload;
	'item:deleted': ItemEventPayload;
	'item:extracted': ItemEventPayload;
	'item:validated': ItemValidatedPayload;

	// Pipeline events
	'pipeline:started': PipelineEventPayload;
	'pipeline:step-started': PipelineStepEventPayload;
	'pipeline:step-completed': PipelineStepCompletedPayload;
	'pipeline:step-failed': PipelineStepFailedPayload;
	'pipeline:completed': PipelineCompletedPayload;
	'pipeline:failed': PipelineFailedPayload;
	'pipeline:cancelled': PipelineEventPayload;

	// System events
	'system:startup': SystemEventPayload;
	'system:shutdown': SystemEventPayload;
	'system:health-check': SystemEventPayload;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends PluginEventName> = (payload: PluginEventPayloads[T]) => void | Promise<void>;

/**
 * Event subscription
 */
export interface EventSubscription {
	/** Unsubscribe from the event */
	readonly unsubscribe: () => void;
}

/**
 * Event emitter interface for plugins
 */
export interface PluginEventEmitter {
	/** Subscribe to an event */
	on<T extends PluginEventName>(event: T, handler: EventHandler<T>): EventSubscription;
	/** Subscribe to an event once */
	once<T extends PluginEventName>(event: T, handler: EventHandler<T>): EventSubscription;
	/** Emit an event */
	emit<T extends PluginEventName>(event: T, payload: PluginEventPayloads[T]): void;
}
