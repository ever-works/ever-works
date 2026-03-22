import { SimStudioClient, SimStudioError, type WorkflowExecutionResult } from 'simstudio-ts-sdk';
import type { SimAiSettings, SimWorkflowInput } from '../types.js';

export interface SimExecutionResult {
	output: unknown;
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
	 * Executes a workflow synchronously.
	 * Input fields are passed directly as top-level properties so the
	 * SIM Start block can access them via `<start.metadata>`, `<start.existingSummary>`, etc.
	 *
	 * Uses sync mode because SIM's async mode returns a different output structure
	 * where structured response format (JSON schema) can fail, producing empty content.
	 * The plugin already runs inside a background job, so blocking here is fine.
	 */
	async executeWorkflow(
		workflowId: string,
		input: SimWorkflowInput,
		settings: SimAiSettings,
		onPollProgress?: (attempt: number, status: string) => void,
		signal?: AbortSignal
	): Promise<SimExecutionResult> {
		if (signal?.aborted) throw new Error('Pipeline execution was cancelled');

		try {
			const startTime = Date.now();

			this.logger.log(`Executing workflow "${workflowId}"`);

			const result = await this.client.executeWorkflow(workflowId, input, {
				timeout: settings.timeoutMs
			});

			const syncResult = result as WorkflowExecutionResult;
			if (!syncResult.success) {
				throw new Error(syncResult.error || 'SIM workflow execution failed');
			}

			onPollProgress?.(1, 'completed');

			return {
				output: syncResult.output,
				pollingAttempts: 0,
				simDuration: Date.now() - startTime
			};
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
