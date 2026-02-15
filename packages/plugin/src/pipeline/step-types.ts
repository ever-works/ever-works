/**
 * Pipeline execution metrics (generic).
 * Pipeline plugins extend this with their own specific fields.
 */
export interface PipelineMetrics {
	startTime: number;
	duration?: number;
	itemsProcessed: number;
	steps: Record<string, StepMetrics>;
}

/**
 * Metrics for a single pipeline step.
 */
export interface StepMetrics {
	name: string;
	startTime: number;
	duration?: number;
	success: boolean;
	error?: string;
	custom?: Record<string, unknown>;
}

/**
 * Step execution status
 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepResult {
	readonly status: StepStatus;
	readonly metrics?: StepMetrics;
	readonly error?: Error | string;
	readonly continue: boolean;
}
