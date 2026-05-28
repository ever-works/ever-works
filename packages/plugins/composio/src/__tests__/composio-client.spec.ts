import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComposioClient, type ComposioSdkLike } from '../utils/composio-client.js';
import type { ComposioToolRef } from '../types.js';

/**
 * Builds a minimal `ComposioSdkLike` stub that satisfies the SDK contract
 * the plugin uses. Tests then `vi.mocked(stub.tools.execute).mockResolvedValue(...)`.
 */
function buildSdkStub(): ComposioSdkLike {
	return {
		toolkits: {
			get: vi.fn()
		},
		connectedAccounts: {
			list: vi.fn()
		},
		tools: {
			execute: vi.fn()
		}
	} as unknown as ComposioSdkLike;
}

function createClient(sdk: ComposioSdkLike): ComposioClient {
	return new ComposioClient({
		apiKey: 'test-key',
		baseUrl: 'https://composio.test/api/v3',
		logger: { log: vi.fn(), warn: vi.fn() },
		sdkOverride: sdk
	});
}

function createRef(overrides: Partial<ComposioToolRef> = {}): ComposioToolRef {
	return {
		toolkit: 'GMAIL',
		toolSlug: 'GMAIL_SEND_EMAIL',
		userId: 'user-123',
		...overrides
	};
}

/** Builds a vendor-shaped error with a numeric `status` field, mirroring how the SDK surfaces HTTP errors. */
function sdkError(status: number, message: string): Error {
	const err = new Error(message);
	(err as { status?: number }).status = status;
	return err;
}

describe('ComposioClient (SDK-backed)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('constructor', () => {
		it('throws when API key is empty', () => {
			expect(
				() =>
					new ComposioClient({
						apiKey: '',
						logger: { log: vi.fn(), warn: vi.fn() }
					})
			).toThrow(/API key is required/i);
		});

		it('accepts an sdkOverride to bypass real SDK construction in tests', () => {
			const sdk = buildSdkStub();
			expect(() => createClient(sdk)).not.toThrow();
		});
	});

	describe('listToolkits', () => {
		it('calls sdk.toolkits.get with the requested limit', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.toolkits.get).mockResolvedValue({
				items: [{ slug: 'GMAIL', name: 'Gmail' }]
			});

			const result = await createClient(sdk).listToolkits(50);

			expect(result).toEqual([{ slug: 'GMAIL', name: 'Gmail' }]);
			expect(sdk.toolkits.get).toHaveBeenCalledWith({ limit: 50 });
		});

		it('clamps the limit into [1, 200]', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.toolkits.get).mockResolvedValue({ items: [] });
			const client = createClient(sdk);

			await client.listToolkits(99999);
			expect(sdk.toolkits.get).toHaveBeenLastCalledWith({ limit: 200 });

			await client.listToolkits(0);
			expect(sdk.toolkits.get).toHaveBeenLastCalledWith({ limit: 1 });
		});

		it('returns [] when the SDK response has no items', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.toolkits.get).mockResolvedValue({ items: [] });

			expect(await createClient(sdk).listToolkits()).toEqual([]);
		});

		it('translates 401 into an actionable API-key error', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.toolkits.get).mockRejectedValue(sdkError(401, 'unauthorized'));

			await expect(createClient(sdk).listToolkits()).rejects.toThrow(/rejected the API key.*HTTP 401/i);
		});

		it('translates 429 into a rate-limit error', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.toolkits.get).mockRejectedValue(sdkError(429, 'throttled'));

			await expect(createClient(sdk).listToolkits()).rejects.toThrow(/rate limit/i);
		});

		it('translates 5xx into a Composio-status error', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.toolkits.get).mockRejectedValue(sdkError(503, 'maintenance'));

			await expect(createClient(sdk).listToolkits()).rejects.toThrow(/HTTP 503/);
		});

		it('preserves the original message for non-HTTP errors', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.toolkits.get).mockRejectedValue(new Error('network down'));

			await expect(createClient(sdk).listToolkits()).rejects.toThrow(/network down/);
		});
	});

	describe('listConnectedAccounts', () => {
		it('sends userIds and toolkitSlugs as arrays (toolkit uppercased)', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.connectedAccounts.list).mockResolvedValue({ items: [] });

			await createClient(sdk).listConnectedAccounts('user-123', 'gmail');

			expect(sdk.connectedAccounts.list).toHaveBeenCalledWith({
				userIds: ['user-123'],
				toolkitSlugs: ['GMAIL']
			});
		});

		it('omits toolkitSlugs when toolkit is undefined', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.connectedAccounts.list).mockResolvedValue({ items: [] });

			await createClient(sdk).listConnectedAccounts('user-123');

			expect(sdk.connectedAccounts.list).toHaveBeenCalledWith({ userIds: ['user-123'] });
		});

		it('translates a 401 from the SDK with the friendly API-key message', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.connectedAccounts.list).mockRejectedValue(sdkError(401, 'unauthorized'));

			await expect(createClient(sdk).listConnectedAccounts('user-123')).rejects.toThrow(/rejected the API key/i);
		});
	});

	describe('validateConnection', () => {
		it('succeeds when an ACTIVE account exists', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.connectedAccounts.list).mockResolvedValue({
				items: [
					{ id: 'ca_1', status: 'INITIATED', toolkit: { slug: 'GMAIL' } },
					{ id: 'ca_2', status: 'ACTIVE', toolkit: { slug: 'GMAIL' } }
				]
			});

			const account = await createClient(sdk).validateConnection(createRef());
			expect(account.id).toBe('ca_2');
		});

		it('normalizes status to upper-case before matching', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.connectedAccounts.list).mockResolvedValue({
				items: [{ id: 'ca_x', status: 'active', toolkit: { slug: 'GMAIL' } }]
			});

			const account = await createClient(sdk).validateConnection(createRef());
			expect(account.id).toBe('ca_x');
		});

		it('throws a friendly error when no ACTIVE account exists', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.connectedAccounts.list).mockResolvedValue({
				items: [{ id: 'ca_1', status: 'EXPIRED', toolkit: { slug: 'GMAIL' } }]
			});

			await expect(createClient(sdk).validateConnection(createRef())).rejects.toThrow(
				/No active Composio connected account/i
			);
		});
	});

	describe('executeTool', () => {
		it('calls sdk.tools.execute with the slug, userId, and arguments', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.tools.execute).mockResolvedValue({
				successful: true,
				data: { items: [{ name: 'A' }] }
			});

			const result = await createClient(sdk).executeTool(createRef(), { to: 'a@b.c', subject: 'hi' });

			expect((result.data as { items: unknown[] }).items).toHaveLength(1);
			expect(result.composioDuration).toBeGreaterThanOrEqual(0);
			expect(sdk.tools.execute).toHaveBeenCalledWith('GMAIL_SEND_EMAIL', {
				userId: 'user-123',
				arguments: { to: 'a@b.c', subject: 'hi' }
			});
		});

		it('throws when the SDK envelope reports successful=false', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.tools.execute).mockResolvedValue({
				successful: false,
				error: 'gmail quota exceeded',
				logId: 'log_42'
			});

			await expect(createClient(sdk).executeTool(createRef(), {})).rejects.toThrow(
				/gmail quota exceeded.*log_42/i
			);
		});

		it('rejects pre-aborted signals before issuing a request', async () => {
			const sdk = buildSdkStub();
			const controller = new AbortController();
			controller.abort();

			await expect(createClient(sdk).executeTool(createRef(), {}, { signal: controller.signal })).rejects.toThrow(
				/cancelled/i
			);
			expect(sdk.tools.execute).not.toHaveBeenCalled();
		});

		it('rejects when the signal aborts after the SDK call starts but before it resolves', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.tools.execute).mockImplementation(
				() =>
					new Promise(() => {
						/* never resolves */
					})
			);
			const controller = new AbortController();

			const promise = createClient(sdk).executeTool(createRef(), {}, { signal: controller.signal });
			controller.abort();

			await expect(promise).rejects.toThrow(/cancelled/i);
		});

		it('translates SDK 404 into a tool-or-account-not-found message', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.tools.execute).mockRejectedValue(sdkError(404, 'not found'));

			await expect(createClient(sdk).executeTool(createRef(), {})).rejects.toThrow(
				/404.*tool slug or toolkit does not exist/i
			);
		});

		it('translates SDK 401 with the friendly API-key message', async () => {
			const sdk = buildSdkStub();
			vi.mocked(sdk.tools.execute).mockRejectedValue(sdkError(401, 'unauthorized'));

			await expect(createClient(sdk).executeTool(createRef(), {})).rejects.toThrow(/rejected the API key/i);
		});
	});
});
