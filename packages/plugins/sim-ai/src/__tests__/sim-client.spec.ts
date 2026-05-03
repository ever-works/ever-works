import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SimClientWrapper } from '../utils/sim-client.js';
import type { SimAiSettings, SimWorkflowInput } from '../types.js';

// Track mock instances
const mockValidateWorkflow = vi.fn();
const mockGetWorkflowStatus = vi.fn();
const mockExecuteWorkflow = vi.fn();

vi.mock('simstudio-ts-sdk', () => ({
	SimStudioClient: vi.fn().mockImplementation(() => ({
		validateWorkflow: mockValidateWorkflow,
		getWorkflowStatus: mockGetWorkflowStatus,
		executeWorkflow: mockExecuteWorkflow,
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
		timeoutMs: 60000,
		...overrides
	};
}

function createInput(): SimWorkflowInput {
	return {
		metadata: {
			workId: 'dir-1',
			workName: 'Test',
			workSlug: 'test',
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

	describe('executeWorkflow', () => {
		it('should execute workflow and return output', async () => {
			mockExecuteWorkflow.mockResolvedValue({
				success: true,
				output: { items: [{ name: 'Test Item' }] }
			});

			const client = createClient();
			const result = await client.executeWorkflow('wf-123', createInput(), createSettings());

			expect(result.pollingAttempts).toBe(0);
			expect(result.output).toEqual({ items: [{ name: 'Test Item' }] });
			expect(result.simDuration).toBeDefined();
		});

		it('should pass input directly as top-level fields', async () => {
			mockExecuteWorkflow.mockResolvedValue({ success: true, output: { items: [] } });
			const client = createClient();
			const input = createInput();

			await client.executeWorkflow('wf-123', input, createSettings());

			expect(mockExecuteWorkflow).toHaveBeenCalledWith('wf-123', input, { timeout: 60000 });
		});

		it('should pass timeoutMs from settings', async () => {
			mockExecuteWorkflow.mockResolvedValue({ success: true, output: { items: [] } });
			const client = createClient();
			const settings = createSettings({ timeoutMs: 120000 });

			await client.executeWorkflow('wf-123', createInput(), settings);

			expect(mockExecuteWorkflow).toHaveBeenCalledWith('wf-123', expect.anything(), { timeout: 120000 });
		});

		it('should call onPollProgress with completed status', async () => {
			mockExecuteWorkflow.mockResolvedValue({ success: true, output: { items: [] } });
			const client = createClient();
			const onProgress = vi.fn();

			await client.executeWorkflow('wf-123', createInput(), createSettings(), onProgress);

			expect(onProgress).toHaveBeenCalledWith(1, 'completed');
		});

		it('should throw when workflow execution fails', async () => {
			mockExecuteWorkflow.mockResolvedValue({
				success: false,
				error: 'Workflow logic error'
			});
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'Workflow logic error'
			);
		});

		it('should throw generic message when execution fails without error', async () => {
			mockExecuteWorkflow.mockResolvedValue({ success: false });
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'SIM workflow execution failed'
			);
		});

		it('should respect abort signal', async () => {
			const client = createClient();
			const abortController = new AbortController();
			abortController.abort();

			await expect(
				client.executeWorkflow('wf-123', createInput(), createSettings(), undefined, abortController.signal)
			).rejects.toThrow('cancelled');
		});
	});

	describe('error wrapping', () => {
		it('should wrap UNAUTHORIZED error', async () => {
			mockExecuteWorkflow.mockRejectedValue(new SimStudioError('Auth failed', 'UNAUTHORIZED'));
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'Invalid SIM API key'
			);
		});

		it('should wrap TIMEOUT error', async () => {
			mockExecuteWorkflow.mockRejectedValue(new SimStudioError('Timed out', 'TIMEOUT'));
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'timed out'
			);
		});

		it('should wrap RATE_LIMIT_EXCEEDED error', async () => {
			mockExecuteWorkflow.mockRejectedValue(new SimStudioError('Rate limited', 'RATE_LIMIT_EXCEEDED'));
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'rate limit exceeded'
			);
		});

		it('should wrap USAGE_LIMIT_EXCEEDED error', async () => {
			mockExecuteWorkflow.mockRejectedValue(new SimStudioError('Usage limit', 'USAGE_LIMIT_EXCEEDED'));
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'usage limit exceeded'
			);
		});

		it('should wrap INVALID_JSON error', async () => {
			mockExecuteWorkflow.mockRejectedValue(new SimStudioError('Bad JSON', 'INVALID_JSON'));
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'Invalid request'
			);
		});

		it('should wrap unknown SIM errors with generic message', async () => {
			mockExecuteWorkflow.mockRejectedValue(new SimStudioError('Something broke', 'UNKNOWN'));
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'SIM error: Something broke'
			);
		});

		it('should re-throw non-SIM errors unchanged', async () => {
			mockExecuteWorkflow.mockRejectedValue(new TypeError('Cannot read property'));
			const client = createClient();

			await expect(client.executeWorkflow('wf-123', createInput(), createSettings())).rejects.toThrow(
				'Cannot read property'
			);
		});
	});
});
