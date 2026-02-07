/**
 * Plugin lifecycle states
 */
export type PluginState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'error';

/**
 * Plugin lifecycle transition
 */
export interface PluginStateTransition {
	readonly from: PluginState;
	readonly to: PluginState;
	readonly timestamp: number;
	readonly error?: Error | string;
}

/**
 * Plugin health status
 */
export type PluginHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/**
 * Plugin health check result
 */
export interface PluginHealthCheck {
	/** Overall health status */
	readonly status: PluginHealthStatus;
	/** Human-readable message */
	readonly message?: string;
	/** Detailed checks */
	readonly checks?: readonly HealthCheckDetail[];
	/** When the check was performed */
	readonly checkedAt: number;
	/** Time taken to perform check in ms */
	readonly duration?: number;
}

/**
 * Individual health check detail
 */
export interface HealthCheckDetail {
	/** Check name */
	readonly name: string;
	/** Check status */
	readonly status: PluginHealthStatus;
	/** Check message */
	readonly message?: string;
	/** Additional data */
	readonly data?: Record<string, unknown>;
}

/**
 * Plugin runtime information
 */
export interface PluginRuntimeInfo {
	/** Plugin ID */
	readonly pluginId: string;
	/** Current state */
	readonly state: PluginState;
	/** State history */
	readonly stateHistory: readonly PluginStateTransition[];
	/** Last health check */
	readonly healthCheck?: PluginHealthCheck;
	/** When plugin was loaded */
	readonly loadedAt?: number;
	/** Error if in error state */
	readonly error?: Error | string;
	/** Memory usage in bytes */
	readonly memoryUsage?: number;
	/** Number of active operations */
	readonly activeOperations?: number;
}
