import type { PluginLogger } from '@ever-works/plugin';

const DEFAULT_THRESHOLD = 3;

export interface ToolCircuitBreakerOptions {
	logger?: PluginLogger;
	threshold?: number;
}

export interface TrippedTool {
	name: string;
	reason: string;
}

/**
 * Tracks consecutive failures per tool. After `threshold` failures
 * the breaker "trips" and short-circuits subsequent calls.
 *
 * No half-open state — agent sessions are short-lived.
 */
export class ToolCircuitBreaker {
	private readonly failures = new Map<string, number>();
	private readonly lastErrors = new Map<string, string>();
	private readonly threshold: number;
	private readonly logger?: PluginLogger;

	constructor(options?: ToolCircuitBreakerOptions) {
		this.threshold = options?.threshold ?? DEFAULT_THRESHOLD;
		this.logger = options?.logger;
	}

	/** @returns `true` if this failure caused the breaker to trip. */
	recordFailure(toolName: string, error?: unknown): boolean {
		const count = (this.failures.get(toolName) ?? 0) + 1;
		this.failures.set(toolName, count);

		const reason = error instanceof Error ? error.message : String(error ?? 'unknown error');
		this.lastErrors.set(toolName, reason);
		this.logger?.warn(`[circuit-breaker] ${toolName} failure #${count}: ${reason}`);

		if (count === this.threshold) {
			this.logger?.warn(`[circuit-breaker] ${toolName} breaker tripped after ${count} consecutive failures`);
			return true;
		}
		return false;
	}

	/** Resets the failure counter (only while breaker is closed). */
	recordSuccess(toolName: string): void {
		if (!this.isTripped(toolName)) {
			this.failures.delete(toolName);
			this.lastErrors.delete(toolName);
		}
	}

	isTripped(toolName: string): boolean {
		return (this.failures.get(toolName) ?? 0) >= this.threshold;
	}

	getUnavailableMessage(toolName: string): string {
		return (
			`${toolName} service is unavailable after repeated failures. Do NOT call this tool again. ` +
			'Do NOT fabricate items from memory — only create items from data you already retrieved via tools in this session.'
		);
	}

	/** Returns all tools with outstanding consecutive failures (includes tripped). */
	getFailedTools(): TrippedTool[] {
		return [...this.failures.keys()].map((name) => ({
			name,
			reason: this.lastErrors.get(name) ?? 'unknown error'
		}));
	}
}
