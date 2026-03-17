import { SimStudioClient, SimStudioError } from 'simstudio-ts-sdk';
import type { SimAiSettings, SimWorkflowInput } from '../types.js';
import { DEFAULT_POLLING_INTERVAL_MS, DEFAULT_ASYNC_TIMEOUT_MS, DEFAULT_MAX_RETRIES } from '../types.js';
import { delay } from './pipeline-helpers.js';

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

/**
 * Wrapper around SimStudioClient that adds polling, progress reporting,
 * and structured error handling for the Ever Works pipeline context.
 */
export class SimClientWrapper {
	private readonly client: SimStudioClient;
	private readonly logger: SimClientOptions['logger'];

	constructor(options: SimClientOptions) {
		this.client = new SimStudioClient({
			apiKey: options.apiKey,
			baseUrl: options.baseUrl
		});
		this.logger = options.logger;
	}

	/**
	 * Validates that the workflow exists and is deployed.
	 */
	async validateWorkflow(workflowId: string): Promise<void> {
		try {
			const isReady = await this.client.validateWorkflow(workflowId);
			if (!isReady) {
				const status = await this.client.getWorkflowStatus(workflowId);
				if (!status.isDeployed) {
					throw new Error(
						`Workflow "${workflowId}" is not deployed on SIM. ` +
							'Please deploy the workflow from the SIM dashboard before using it.'
					);
				}
				if (status.needsRedeployment) {
					this.logger.warn(
						`Workflow "${workflowId}" has pending changes. Consider redeploying for latest version.`
					);
				}
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
	 * Executes a workflow in sync or async mode.
	 * For async mode, polls until completion or timeout.
	 *
	 * The SIM Start block maps input fields by name. We wrap the entire
	 * structured payload as a JSON string in a `message` field so the
	 * workflow can access it via `<start.message>`.
	 */
	async executeWorkflow(
		workflowId: string,
		input: SimWorkflowInput,
		settings: SimAiSettings,
		onPollProgress?: (attempt: number, status: string) => void,
		signal?: AbortSignal
	): Promise<SimExecutionResult> {
		const executionMode = settings.executionMode || 'async';
		const maxRetries = settings.maxRetries ?? DEFAULT_MAX_RETRIES;

		// Wrap structured payload into the `message` field expected by the SIM Start block
		const wrappedInput = { message: JSON.stringify(input) };

		try {
			if (executionMode === 'sync') {
				return await this.executeSyncWithRetry(workflowId, wrappedInput, settings, maxRetries, signal);
			} else {
				return await this.executeAsync(workflowId, wrappedInput, settings, onPollProgress, signal);
			}
		} catch (error) {
			if (error instanceof SimStudioError) {
				throw this.wrapSimError(error);
			}
			throw error;
		}
	}

	private async executeSyncWithRetry(
		workflowId: string,
		input: Record<string, unknown>,
		settings: SimAiSettings,
		maxRetries: number,
		signal?: AbortSignal
	): Promise<SimExecutionResult> {
		if (signal?.aborted) {
			throw new Error('Pipeline execution was cancelled');
		}

		const startTime = Date.now();

		const result = await this.client.executeWithRetry(
			workflowId,
			input,
			{
				timeout: settings.asyncTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS,
				stream: false
			},
			{
				maxRetries,
				initialDelay: 1000,
				maxDelay: 30000,
				backoffMultiplier: 2
			}
		);

		if (!result.success) {
			const errorMsg = 'error' in result ? (result as { error?: string }).error : undefined;
			throw new Error(errorMsg || 'SIM workflow execution failed');
		}

		return {
			output: 'output' in result ? (result as { output?: unknown }).output : undefined,
			pollingAttempts: 0,
			simDuration: Date.now() - startTime
		};
	}

	private async executeAsync(
		workflowId: string,
		input: Record<string, unknown>,
		settings: SimAiSettings,
		onPollProgress?: (attempt: number, status: string) => void,
		signal?: AbortSignal
	): Promise<SimExecutionResult> {
		const startTime = Date.now();
		const pollingInterval = settings.asyncPollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
		const timeout = settings.asyncTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS;

		this.logger.log(`Executing SIM workflow "${workflowId}" in async mode`);

		const result = await this.client.executeWorkflow(workflowId, input, {
			async: true
		});

		// SIM returns jobId for async execution, check both jobId and taskId
		const asyncResult = result as Record<string, unknown>;
		const jobId = (asyncResult.jobId ?? asyncResult.taskId) as string | undefined;

		// If no job/task ID, the workflow completed synchronously
		if (!jobId) {
			const output = asyncResult.output ?? result;
			return {
				output,
				pollingAttempts: 0,
				simDuration: Date.now() - startTime
			};
		}

		this.logger.log(`SIM workflow queued with job ID: ${jobId}`);
		const taskId = jobId;

		// Poll for completion
		let pollingAttempts = 0;

		while (true) {
			if (signal?.aborted) {
				throw new Error('Pipeline execution was cancelled');
			}

			if (Date.now() - startTime > timeout) {
				throw new Error(
					`SIM workflow timed out after ${Math.round(timeout / 1000)}s. ` +
						`Task ID: ${taskId}. You can check its status in the SIM dashboard.`
				);
			}

			const status = await this.client.getJobStatus(taskId);
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

			// 'queued' or 'processing' — wait before next poll
			await delay(pollingInterval);
		}
	}

	private wrapSimError(error: SimStudioError): Error {
		switch (error.code) {
			case 'UNAUTHORIZED':
				return new Error('Invalid SIM API key. Please update your API key in plugin settings.');
			case 'TIMEOUT':
				return new Error('SIM workflow execution timed out. Try increasing the timeout or using async mode.');
			case 'RATE_LIMIT_EXCEEDED':
				return new Error('SIM rate limit exceeded. Please wait and try again.');
			case 'USAGE_LIMIT_EXCEEDED':
				return new Error('SIM usage limit exceeded. Check your SIM account plan and usage limits.');
			case 'INVALID_JSON':
				return new Error('Invalid request sent to SIM. This may be a plugin bug — please report it.');
			default:
				return new Error(`SIM error: ${error.message}`);
		}
	}
}
