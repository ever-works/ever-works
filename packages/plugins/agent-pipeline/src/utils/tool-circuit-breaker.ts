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
 * Lightweight circuit breaker for external service tools.
 *
 * Tracks consecutive failures per tool name. After `threshold` consecutive
 * failures the breaker "trips" and short-circuits subsequent calls so the
 * AI model stops retrying a broken service.
 *
 * No half-open / reset-timer state — agent sessions are short-lived, so
 * once a service is confirmed dead it stays dead for the session.
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

	/**
	 * Record a failure for the given tool.
	 * @returns `true` if this failure caused the breaker to trip.
	 */
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

	/**
	 * Record a success — resets the failure counter (only while breaker is closed).
	 */
	recordSuccess(toolName: string): void {
		if (!this.isTripped(toolName)) {
			this.failures.delete(toolName);
			this.lastErrors.delete(toolName);
		}
	}

	/**
	 * Whether the breaker has tripped (failures >= threshold).
	 */
	isTripped(toolName: string): boolean {
		return (this.failures.get(toolName) ?? 0) >= this.threshold;
	}

	/**
	 * Imperative message telling the model to stop calling this tool.
	 */
	getUnavailableMessage(toolName: string): string {
		return `${toolName} service is unavailable after repeated failures. Do NOT call this tool again — use other tools or your own knowledge instead.`;
	}

	/**
	 * Returns all tools whose breakers have tripped, with the last error reason.
	 */
	getTrippedTools(): TrippedTool[] {
		const tripped: TrippedTool[] = [];
		for (const [toolName, count] of this.failures) {
			if (count >= this.threshold) {
				tripped.push({
					name: toolName,
					reason: this.lastErrors.get(toolName) ?? 'unknown error'
				});
			}
		}
		return tripped;
	}
}
