import {
	SimStudioClient,
	SimStudioError,
	type WorkflowExecutionResult,
	type AsyncExecutionResult
} from 'simstudio-ts-sdk';
import type { SimAiSettings, SimWorkflowInput } from '../types.js';
import { DEFAULT_POLLING_INTERVAL_MS } from '../types.js';

export interface SimExecutionResult {
	output: unknown;
	taskId?: string;
	pollingAttempts: number;
	simDuration?: number;
}

interface SimClientOptions {
	apiKey: string;
	baseUrl: string;
	logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/** Job status shape from SIM API (SDK types it as `any`) */
interface JobStatus {
	status: 'completed' | 'failed' | 'cancelled' | 'queued' | 'processing';
	output?: unknown;
	error?: string;
	metadata?: { duration?: number; [key: string]: unknown };
}

/**
 * Type guard: distinguish async queued result from sync completion.
 * AsyncExecutionResult always has `taskId` and `status: 'queued'`.
 */
function isAsyncResult(result: WorkflowExecutionResult | AsyncExecutionResult): result is AsyncExecutionResult {
	return 'taskId' in result && (result as AsyncExecutionResult).status === 'queued';
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrapper around SimStudioClient that adds polling, progress reporting,
 * and user-friendly error handling.
 */
export class SimClientWrapper {
	private readonly client: SimStudioClient;
	private readonly logger: SimClientOptions['logger'];

	constructor(options: SimClientOptions) {
		this.client = new SimStudioClient({ apiKey: options.apiKey, baseUrl: options.baseUrl });
		this.logger = options.logger;
	}

	/** Validates that the workflow exists, is deployed, and rate limits allow execution. */
	async validateWorkflow(workflowId: string): Promise<void> {
		try {
			const isReady = await this.client.validateWorkflow(workflowId);
			if (!isReady) {
				const status = await this.client.getWorkflowStatus(workflowId);
				if (!status.isDeployed) {
					throw new Error(
						`Workflow "${workflowId}" is not deployed. Deploy it from the SIM dashboard first.`
					);
				}
				if (status.needsRedeployment) {
					this.logger.warn(`Workflow "${workflowId}" has pending changes. Consider redeploying.`);
				}
			}

			// Pre-check rate limits to fail fast with a clear message
			const rateLimitInfo = this.client.getRateLimitInfo();
			if (rateLimitInfo && rateLimitInfo.remaining <= 0) {
				const retryIn = rateLimitInfo.retryAfter ?? Math.ceil((rateLimitInfo.reset - Date.now()) / 1000);
				throw new Error(
					`SIM rate limit exhausted. Retry in ${retryIn}s. ` +
						'You can check your limits in the SIM dashboard.'
				);
			}
		} catch (error) {
			if (error instanceof SimStudioError) {
				if (error.code === 'UNAUTHORIZED') {
					throw new Error('Invalid SIM API key. Please check your API key in plugin settings.');
				}
				throw new Error(`SIM validation failed: ${error.message}`);
			}
			throw error;
		}
	}

	/**
	 * Executes a workflow asynchronously with polling.
	 * Input fields are passed directly as top-level properties so the
	 * SIM Start block can access them via `<start.metadata>`, `<start.existingSummary>`, etc.
	 */
	async executeWorkflow(
		workflowId: string,
		input: SimWorkflowInput,
		settings: SimAiSettings,
		onPollProgress?: (attempt: number, status: string) => void,
		signal?: AbortSignal
	): Promise<SimExecutionResult> {
		try {
			const startTime = Date.now();
			const pollingInterval = settings.asyncPollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
			const timeout = settings.asyncTimeoutMs;

			this.logger.log(`Executing workflow "${workflowId}" asynchronously`);

			const result = await this.client.executeWorkflow(workflowId, input, { async: true });

			// If workflow completed synchronously despite async request
			if (!isAsyncResult(result)) {
				return { output: result.output, pollingAttempts: 0, simDuration: Date.now() - startTime };
			}

			const taskId = result.taskId;
			this.logger.log(`Workflow queued with task ID: ${taskId}`);

			let pollingAttempts = 0;

			while (true) {
				if (signal?.aborted) throw new Error('Pipeline execution was cancelled');

				if (Date.now() - startTime > timeout) {
					throw new Error(
						`SIM workflow timed out after ${Math.round(timeout / 1000)}s. ` +
							`Task ID: ${taskId}. Check status in the SIM dashboard.`
					);
				}

				const status = (await this.client.getJobStatus(taskId)) as JobStatus;
				pollingAttempts++;
				onPollProgress?.(pollingAttempts, status.status);
				this.logger.log(`Poll #${pollingAttempts}: status=${status.status}`);

				if (status.status === 'completed') {
					return {
						output: status.output,
						taskId,
						pollingAttempts,
						simDuration: status.metadata?.duration ?? Date.now() - startTime
					};
				}

				if (status.status === 'failed') {
					throw new Error(`SIM workflow failed: ${status.error || 'Unknown error'}. Task ID: ${taskId}`);
				}

				if (status.status === 'cancelled') {
					throw new Error(`SIM workflow was cancelled. Task ID: ${taskId}`);
				}

				await delay(pollingInterval);
			}
		} catch (error) {
			if (error instanceof SimStudioError) throw this.wrapSimError(error);
			throw error;
		}
	}

	private wrapSimError(error: SimStudioError): Error {
		const messages: Record<string, string> = {
			UNAUTHORIZED: 'Invalid SIM API key. Please update your API key in plugin settings.',
			TIMEOUT: 'SIM workflow execution timed out. Try increasing the workflow timeout setting.',
			RATE_LIMIT_EXCEEDED: 'SIM rate limit exceeded. Please wait and try again.',
			USAGE_LIMIT_EXCEEDED: 'SIM usage limit exceeded. Check your SIM account plan and usage limits.',
			INVALID_JSON: 'Invalid request sent to SIM. This may be a plugin bug — please report it.'
		};
		return new Error(messages[error.code ?? ''] ?? `SIM error: ${error.message}`);
	}
}
