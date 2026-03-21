import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SimClientWrapper } from '../utils/sim-client.js';
import type { SimAiSettings, SimWorkflowInput } from '../types.js';

// Track mock instances
const mockValidateWorkflow = vi.fn();
const mockGetWorkflowStatus = vi.fn();
const mockExecuteWithRetry = vi.fn();
const mockExecuteWorkflow = vi.fn();
const mockGetJobStatus = vi.fn();

vi.mock('simstudio-ts-sdk', () => ({
	SimStudioClient: vi.fn().mockImplementation(() => ({
		validateWorkflow: mockValidateWorkflow,
		getWorkflowStatus: mockGetWorkflowStatus,
		executeWithRetry: mockExecuteWithRetry,
		executeWorkflow: mockExecuteWorkflow,
		getJobStatus: mockGetJobStatus,
		getRateLimitInfo: vi.fn().mockReturnValue(null)
	})),
	SimStudioError: class SimStudioError extends Error {
		code?: string;
		status?: number;
		constructor(message: string, code?: string) {
			super(message);
			this.code = code;
		}
	}
}));

// Need to import after mock setup
const { SimStudioError } = await import('simstudio-ts-sdk');

function createClient(): SimClientWrapper {
	return new SimClientWrapper({
		apiKey: 'test-key',
		baseUrl: 'https://sim.test',
		logger: { log: vi.fn(), warn: vi.fn() }
	});
}

function createSettings(overrides?: Partial<SimAiSettings>): SimAiSettings {
	return {
		apiKey: 'test-key',
		baseUrl: 'https://sim.test',
		executionMode: 'sync',
		asyncPollingIntervalMs: 100,
		asyncTimeoutMs: 5000,
		maxRetries: 2,
		...overrides
	};
}

function createInput(): SimWorkflowInput {
	return {
		metadata: {
			directoryId: 'dir-1',
			directoryName: 'Test',
			directorySlug: 'test',
			targetItems: 50
		}
	};
}

describe('SimClientWrapper', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('validateWorkflow', () => {
		it('should succeed when workflow is valid', async () => {
			mockValidateWorkflow.mockResolvedValue(true);
			const client = createClient();

			await expect(client.validateWorkflow('wf-123')).resolves.toBeUndefined();
			expect(mockValidateWorkflow).toHaveBeenCalledWith('wf-123');
		});

		it('should throw when workflow is not deployed', async () => {
			mockValidateWorkflow.mockResolvedValue(false);
			mockGetWorkflowStatus.mockResolvedValue({ isDeployed: false, needsRedeployment: false });
			const client = createClient();

			await expect(client.validateWorkflow('wf-bad')).rejects.toThrow('not deployed');
		});

		it('should warn when workflow needs redeployment', async () => {
			mockValidateWorkflow.mockResolvedValue(false);
			mockGetWorkflowStatus.mockResolvedValue({ isDeployed: true, needsRedeployment: true });
			const client = createClient();
			const warnFn = vi.fn();
			(client as any).logger = { log: vi.fn(), warn: warnFn };

			await client.validateWorkflow('wf-old');
			expect(warnFn).toHaveBeenCalledWith(expect.stringContaining('pending changes'));
		});

		it('should throw user-friendly message on UNAUTHORIZED error', async () => {
			mockValidateWorkflow.mockRejectedValue(new SimStudioError('Unauthorized', 'UNAUTHORIZED'));
			const client = createClient();

			await expect(client.validateWorkflow('wf-123')).rejects.toThrow('Invalid SIM API key');
		});

		it('should wrap other SimStudioError messages', async () => {
			mockValidateWorkflow.mockRejectedValue(new SimStudioError('Server error', 'SERVER_ERROR'));
			const client = createClient();

			await expect(client.validateWorkflow('wf-123')).rejects.toThrow('SIM validation failed');
		});

		it('should re-throw non-SIM errors as-is', async () => {
			mockValidateWorkflow.mockRejectedValue(new Error('Network error'));
			const client = createClient();

			await expect(client.validateWorkflow('wf-123')).rejects.toThrow('Network error');
		});
	});

	describe('executeWorkflow - sync mode', () => {
		it('should execute with retry and return result', async () => {
			mockExecuteWithRetry.mockResolvedValue({
				success: true,
				output: { items: [{ name: 'Item 1' }] }
			});
			const client = createClient();
			const settings = createSettings({ executionMode: 'sync' });

			const result = await client.executeWorkflow('wf-123', createInput(), settings);

			expect(result.pollingAttempts).toBe(0);
			expect(result.output).toEqual({ items: [{ name: 'Item 1' }] });
			expect(result.simDuration).toBeGreaterThanOrEqual(0);
			expect(mockExecuteWithRetry).toHaveBeenCalledWith(
				'wf-123',
				expect.any(Object),
				expect.objectContaining({ stream: false }),
				expect.objectContaining({ maxRetries: 2 })
			);
		});

		it('should throw on unsuccessful sync result', async () => {
			mockExecuteWithRetry.mockResolvedValue({
				success: false,
				error: 'Workflow crashed'
			});
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('Workflow crashed');
		});

		it('should throw generic message when no error detail', async () => {
			mockExecuteWithRetry.mockResolvedValue({ success: false });
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('SIM workflow execution failed');
		});
	});

	describe('executeWorkflow - async mode', () => {
		it('should poll until completion', async () => {
			mockExecuteWorkflow.mockResolvedValue({
				success: true,
				taskId: 'task-1',
				status: 'queued',
				createdAt: '',
				links: { status: '' }
			});
			mockGetJobStatus.mockResolvedValueOnce({ status: 'processing' }).mockResolvedValueOnce({
				status: 'completed',
				output: { items: [{ name: 'Async Item' }] },
				metadata: { duration: 3000 }
			});

			const client = createClient();
			const settings = createSettings({ executionMode: 'async', asyncPollingIntervalMs: 10 });
			const onProgress = vi.fn();

			const result = await client.executeWorkflow('wf-123', createInput(), settings, onProgress);

			expect(result.taskId).toBe('task-1');
			expect(result.pollingAttempts).toBe(2);
			expect(result.output).toEqual({ items: [{ name: 'Async Item' }] });
			expect(result.simDuration).toBe(3000);
			expect(onProgress).toHaveBeenCalledTimes(2);
		});

		it('should handle synchronous completion in async mode', async () => {
			mockExecuteWorkflow.mockResolvedValue({
				success: true,
				output: { items: [{ name: 'Quick Item' }] }
			});
			const client = createClient();
			const settings = createSettings({ executionMode: 'async' });

			const result = await client.executeWorkflow('wf-123', createInput(), settings);

			expect(result.pollingAttempts).toBe(0);
			expect(result.output).toEqual({ items: [{ name: 'Quick Item' }] });
			expect(mockGetJobStatus).not.toHaveBeenCalled();
		});

		it('should throw on failed status', async () => {
			mockExecuteWorkflow.mockResolvedValue({
				success: true,
				taskId: 'task-fail',
				status: 'queued',
				createdAt: '',
				links: { status: '' }
			});
			mockGetJobStatus.mockResolvedValue({ status: 'failed', error: 'Out of memory' });

			const client = createClient();
			const settings = createSettings({ executionMode: 'async', asyncPollingIntervalMs: 10 });

			await expect(client.executeWorkflow('wf-123', createInput(), settings)).rejects.toThrow('Out of memory');
		});

		it('should throw on cancelled status', async () => {
			mockExecuteWorkflow.mockResolvedValue({
				success: true,
				taskId: 'task-cancel',
				status: 'queued',
				createdAt: '',
				links: { status: '' }
			});
			mockGetJobStatus.mockResolvedValue({ status: 'cancelled' });

			const client = createClient();
			const settings = createSettings({ executionMode: 'async', asyncPollingIntervalMs: 10 });

			await expect(client.executeWorkflow('wf-123', createInput(), settings)).rejects.toThrow('was cancelled');
		});

		it('should throw on timeout', async () => {
			mockExecuteWorkflow.mockResolvedValue({
				success: true,
				taskId: 'task-slow',
				status: 'queued',
				createdAt: '',
				links: { status: '' }
			});
			mockGetJobStatus.mockResolvedValue({ status: 'processing' });

			const client = createClient();
			const settings = createSettings({
				executionMode: 'async',
				asyncPollingIntervalMs: 10,
				asyncTimeoutMs: 50
			});

			await expect(client.executeWorkflow('wf-123', createInput(), settings)).rejects.toThrow('timed out');
		});

		it('should respect abort signal', async () => {
			mockExecuteWorkflow.mockResolvedValue({
				success: true,
				taskId: 'task-abort',
				status: 'queued',
				createdAt: '',
				links: { status: '' }
			});
			mockGetJobStatus.mockResolvedValue({ status: 'processing' });

			const client = createClient();
			const settings = createSettings({ executionMode: 'async', asyncPollingIntervalMs: 10 });
			const abortController = new AbortController();
			abortController.abort();

			await expect(
				client.executeWorkflow('wf-123', createInput(), settings, undefined, abortController.signal)
			).rejects.toThrow('cancelled');
		});
	});

	describe('error wrapping', () => {
		it('should wrap UNAUTHORIZED error', async () => {
			mockExecuteWithRetry.mockRejectedValue(new SimStudioError('Auth failed', 'UNAUTHORIZED'));
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('Invalid SIM API key');
		});

		it('should wrap TIMEOUT error', async () => {
			mockExecuteWithRetry.mockRejectedValue(new SimStudioError('Timed out', 'TIMEOUT'));
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('timed out');
		});

		it('should wrap RATE_LIMIT_EXCEEDED error', async () => {
			mockExecuteWithRetry.mockRejectedValue(new SimStudioError('Rate limited', 'RATE_LIMIT_EXCEEDED'));
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('rate limit exceeded');
		});

		it('should wrap USAGE_LIMIT_EXCEEDED error', async () => {
			mockExecuteWithRetry.mockRejectedValue(new SimStudioError('Usage limit', 'USAGE_LIMIT_EXCEEDED'));
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('usage limit exceeded');
		});

		it('should wrap INVALID_JSON error', async () => {
			mockExecuteWithRetry.mockRejectedValue(new SimStudioError('Bad JSON', 'INVALID_JSON'));
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('Invalid request');
		});

		it('should wrap unknown SIM errors with generic message', async () => {
			mockExecuteWithRetry.mockRejectedValue(new SimStudioError('Something broke', 'UNKNOWN'));
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('SIM error: Something broke');
		});

		it('should re-throw non-SIM errors unchanged', async () => {
			mockExecuteWithRetry.mockRejectedValue(new TypeError('Cannot read property'));
			const client = createClient();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings({ executionMode: 'sync' }))
			).rejects.toThrow('Cannot read property');
		});
	});
});
