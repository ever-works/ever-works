import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZapierClient } from '../utils/zapier-client.js';
import type { ZapierActionRef } from '../types.js';

const { mockGetAction, mockRunAction, mockCreateSdk } = vi.hoisted(() => {
	const mockGetAction = vi.fn();
	const mockRunAction = vi.fn();
	const mockCreateSdk = vi.fn().mockImplementation(() => ({
		getAction: mockGetAction,
		runAction: mockRunAction
	}));
	return { mockGetAction, mockRunAction, mockCreateSdk };
});

vi.mock('@zapier/zapier-sdk', () => {
	class ZapierError extends Error {
		readonly code: string = 'ZAPIER_ERROR';
	}
	class ZapierAppNotFoundError extends ZapierError {
		readonly code = 'ZAPIER_APP_NOT_FOUND_ERROR';
		appKey?: string;
		constructor(message: string, options?: { appKey?: string }) {
			super(message);
			this.appKey = options?.appKey;
		}
	}
	class ZapierNotFoundError extends ZapierError {
		readonly code = 'ZAPIER_NOT_FOUND_ERROR';
	}
	class ZapierAuthenticationError extends ZapierError {
		readonly code = 'ZAPIER_AUTHENTICATION_ERROR';
	}
	class ZapierRateLimitError extends ZapierError {
		readonly code = 'ZAPIER_RATE_LIMIT_ERROR';
	}
	class ZapierTimeoutError extends ZapierError {
		readonly code = 'ZAPIER_TIMEOUT_ERROR';
	}
	class ZapierValidationError extends ZapierError {
		readonly code = 'ZAPIER_VALIDATION_ERROR';
	}
	class ZapierActionError extends ZapierError {
		readonly code = 'ZAPIER_ACTION_ERROR';
	}
	return {
		createZapierSdk: mockCreateSdk,
		ZapierError,
		ZapierAppNotFoundError,
		ZapierNotFoundError,
		ZapierAuthenticationError,
		ZapierRateLimitError,
		ZapierTimeoutError,
		ZapierValidationError,
		ZapierActionError
	};
});

const {
	ZapierError,
	ZapierAppNotFoundError,
	ZapierNotFoundError,
	ZapierAuthenticationError,
	ZapierRateLimitError,
	ZapierTimeoutError,
	ZapierValidationError,
	ZapierActionError
} = await import('@zapier/zapier-sdk');

function createClient(): ZapierClient {
	return new ZapierClient({
		accessToken: 'test-token',
		baseUrl: 'https://actions.zapier.test',
		logger: { log: vi.fn(), warn: vi.fn() }
	});
}

function createRef(): ZapierActionRef {
	return {
		appKey: 'slack',
		actionType: 'write',
		actionKey: 'custom',
		authenticationId: 12345
	};
}

describe('ZapierClient', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('constructor auth wiring', () => {
		it('should pass { token } to the SDK when only accessToken is provided', () => {
			new ZapierClient({
				accessToken: 'eyJ-token',
				logger: { log: vi.fn(), warn: vi.fn() }
			});
			expect(mockCreateSdk).toHaveBeenCalledWith(expect.objectContaining({ token: 'eyJ-token' }));
			expect(mockCreateSdk.mock.calls[0][0]).not.toHaveProperty('credentials');
		});

		it('should pass { credentials: { clientId, clientSecret } } when credentials are provided', () => {
			new ZapierClient({
				credentials: { clientId: 'ckc_x', clientSecret: 'cks_x' },
				logger: { log: vi.fn(), warn: vi.fn() }
			});
			expect(mockCreateSdk).toHaveBeenCalledWith(
				expect.objectContaining({ credentials: { clientId: 'ckc_x', clientSecret: 'cks_x' } })
			);
			expect(mockCreateSdk.mock.calls[0][0]).not.toHaveProperty('token');
		});

		it('should prefer credentials over accessToken when both are provided', () => {
			new ZapierClient({
				accessToken: 'eyJ-token',
				credentials: { clientId: 'ckc_x', clientSecret: 'cks_x' },
				logger: { log: vi.fn(), warn: vi.fn() }
			});
			const arg = mockCreateSdk.mock.calls[0][0];
			expect(arg.credentials).toEqual({ clientId: 'ckc_x', clientSecret: 'cks_x' });
			expect(arg.token).toBeUndefined();
		});

		it('should throw when no auth method is provided', () => {
			expect(
				() =>
					new ZapierClient({
						logger: { log: vi.fn(), warn: vi.fn() }
					})
			).toThrow(/authentication is not configured/i);
		});
	});

	describe('validateAction', () => {
		it('should unwrap the .data action metadata on success', async () => {
			mockGetAction.mockResolvedValue({ data: { key: 'custom' } });
			const client = createClient();

			await expect(client.validateAction(createRef())).resolves.toEqual({ key: 'custom' });
			expect(mockGetAction).toHaveBeenCalledWith({
				appKey: 'slack',
				actionType: 'write',
				actionKey: 'custom'
			});
		});

		it('should wrap ZapierAppNotFoundError with a friendly message', async () => {
			mockGetAction.mockRejectedValue(new ZapierAppNotFoundError('slack not found', { appKey: 'slack' }));
			const client = createClient();

			await expect(client.validateAction(createRef())).rejects.toThrow('Zapier app "slack" was not found');
		});

		it('should translate authentication errors', async () => {
			mockGetAction.mockRejectedValue(new ZapierAuthenticationError('Unauthorized'));
			const client = createClient();

			await expect(client.validateAction(createRef())).rejects.toThrow(/invalid or expired/i);
		});

		it('should translate not-found errors', async () => {
			mockGetAction.mockRejectedValue(new ZapierNotFoundError('Nope'));
			const client = createClient();

			await expect(client.validateAction(createRef())).rejects.toThrow(/not found/);
		});

		it('should re-throw plain Errors unchanged', async () => {
			mockGetAction.mockRejectedValue(new Error('network down'));
			const client = createClient();

			await expect(client.validateAction(createRef())).rejects.toThrow('network down');
		});
	});

	describe('executeAction', () => {
		it('should return execution result on success', async () => {
			mockRunAction.mockResolvedValue({ data: [{ name: 'A' }], nextCursor: 'cursor-1' });
			const client = createClient();

			const result = await client.executeAction(createRef(), { foo: 'bar' });

			expect(result.data).toEqual([{ name: 'A' }]);
			expect(result.nextCursor).toBe('cursor-1');
			expect(result.zapierDuration).toBeGreaterThanOrEqual(0);
		});

		it('should pass appKey, actionType, actionKey, authenticationId, and inputs to runAction', async () => {
			mockRunAction.mockResolvedValue({ data: [] });
			const client = createClient();

			await client.executeAction(createRef(), { custom: 'input' });

			expect(mockRunAction).toHaveBeenCalledWith({
				appKey: 'slack',
				actionType: 'write',
				actionKey: 'custom',
				authenticationId: 12345,
				inputs: { custom: 'input' }
			});
		});

		it('should reject immediately when the signal is already aborted', async () => {
			const client = createClient();
			const controller = new AbortController();
			controller.abort();

			await expect(client.executeAction(createRef(), {}, controller.signal)).rejects.toThrow('cancelled');
			expect(mockRunAction).not.toHaveBeenCalled();
		});

		it('should reject when the signal aborts during execution', async () => {
			mockRunAction.mockImplementation(
				() =>
					new Promise(() => {
						/* never resolves */
					})
			);
			const client = createClient();
			const controller = new AbortController();

			const promise = client.executeAction(createRef(), {}, controller.signal);
			controller.abort();

			await expect(promise).rejects.toThrow('cancelled');
		});

		it('should translate rate-limit errors', async () => {
			mockRunAction.mockRejectedValue(new ZapierRateLimitError('Throttled'));
			const client = createClient();

			await expect(client.executeAction(createRef(), {})).rejects.toThrow(/rate limit/);
		});

		it('should translate timeout errors', async () => {
			mockRunAction.mockRejectedValue(new ZapierTimeoutError('Timed out'));
			const client = createClient();

			await expect(client.executeAction(createRef(), {})).rejects.toThrow(/timed out/);
		});

		it('should translate validation errors', async () => {
			mockRunAction.mockRejectedValue(new ZapierValidationError('Bad input'));
			const client = createClient();

			await expect(client.executeAction(createRef(), {})).rejects.toThrow(/rejected the action inputs/);
		});

		it('should translate action errors (third-party failures)', async () => {
			mockRunAction.mockRejectedValue(new ZapierActionError('Slack said no'));
			const client = createClient();

			await expect(client.executeAction(createRef(), {})).rejects.toThrow(/Zapier action failed/);
		});

		it('should fall back to generic message for unknown ZapierError subclasses', async () => {
			class CustomZapierError extends ZapierError {
				readonly code = 'ZAPIER_WHO_KNOWS';
			}
			mockRunAction.mockRejectedValue(new CustomZapierError('Boom'));
			const client = createClient();

			await expect(client.executeAction(createRef(), {})).rejects.toThrow(/Zapier error during run action/);
		});

		it('should wrap ZapierAppNotFoundError during execution', async () => {
			mockRunAction.mockRejectedValue(new ZapierAppNotFoundError('slack gone', { appKey: 'slack' }));
			const client = createClient();

			await expect(client.executeAction(createRef(), {})).rejects.toThrow('Zapier app "slack" was not found');
		});
	});
});
