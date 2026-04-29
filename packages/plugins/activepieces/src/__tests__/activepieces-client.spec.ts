import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivepiecesClient } from '../utils/activepieces-client.js';
import type { ActivepiecesSettings } from '../types.js';

function createClient() {
	return new ActivepiecesClient({
		apiKey: 'test-key',
		baseUrl: 'https://cloud.activepieces.test/api/v1',
		logger: { log: vi.fn(), warn: vi.fn() }
	});
}

function createSettings(overrides?: Partial<ActivepiecesSettings>): ActivepiecesSettings {
	return {
		apiKey: 'test-key',
		baseUrl: 'https://cloud.activepieces.test/api/v1',
		webhookMode: 'sync',
		timeoutMs: 60000,
		...overrides
	};
}

function mockJsonResponse(data: unknown, init?: { status?: number; statusText?: string }) {
	return new Response(JSON.stringify(data), {
		status: init?.status ?? 200,
		statusText: init?.statusText ?? 'OK',
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('ActivepiecesClient', () => {
	const fetchSpy = vi.spyOn(globalThis, 'fetch');

	beforeEach(() => {
		fetchSpy.mockReset();
	});

	afterEach(() => {
		fetchSpy.mockReset();
	});

	describe('validateFlow', () => {
		it('should fetch the flow and require ENABLED status', async () => {
			fetchSpy.mockResolvedValue(mockJsonResponse({ id: 'flow-1', status: 'ENABLED', publishedVersionId: 'v1' }));

			const client = createClient();
			const flow = await client.validateFlow('flow-1');

			expect(flow.id).toBe('flow-1');
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const [url, init] = fetchSpy.mock.calls[0]!;
			expect(String(url)).toContain('/api/v1/flows/flow-1');
			expect((init as RequestInit).method).toBe('GET');
			expect(((init as RequestInit).headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
		});

		it('should reject flows that are not enabled', async () => {
			fetchSpy.mockResolvedValue(
				mockJsonResponse({ id: 'flow-1', status: 'DISABLED', publishedVersionId: 'v1' })
			);

			const client = createClient();
			await expect(client.validateFlow('flow-1')).rejects.toThrow(/not enabled/);
		});

		it('should warn when flow has no published version', async () => {
			fetchSpy.mockResolvedValue(mockJsonResponse({ id: 'flow-1', status: 'ENABLED', publishedVersionId: null }));

			const warn = vi.fn();
			const client = new ActivepiecesClient({
				apiKey: 'k',
				baseUrl: 'https://api.test',
				logger: { log: vi.fn(), warn }
			});
			await client.validateFlow('flow-1');
			expect(warn).toHaveBeenCalled();
		});

		it('should map 401 to a friendly auth error', async () => {
			fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
			await expect(createClient().validateFlow('flow-1')).rejects.toThrow(/Invalid Activepieces API key/);
		});

		it('should map 404 to a friendly not-found error', async () => {
			fetchSpy.mockResolvedValue(new Response('not found', { status: 404, statusText: 'Not Found' }));
			await expect(createClient().validateFlow('flow-1')).rejects.toThrow(/not found/);
		});
	});

	describe('executeFlow', () => {
		it('should POST to the sync webhook URL by default', async () => {
			fetchSpy.mockResolvedValue(mockJsonResponse({ items: [{ name: 'A' }] }));

			const client = createClient();
			const result = await client.executeFlow(
				'flow-1',
				{ metadata: { directoryId: 'd', directoryName: 'D', directorySlug: 'd', targetItems: 1 } },
				createSettings()
			);

			const [url, init] = fetchSpy.mock.calls[0]!;
			expect(String(url)).toContain('/api/v1/webhooks/flow-1/sync');
			expect((init as RequestInit).method).toBe('POST');
			expect(JSON.parse((init as RequestInit).body as string).metadata.directoryId).toBe('d');
			expect(result.output).toEqual({ items: [{ name: 'A' }] });
			expect(result.flowDuration).toBeDefined();
		});

		it('should POST to async webhook URL when mode is async', async () => {
			fetchSpy.mockResolvedValue(mockJsonResponse({ runId: 'run-1' }));

			await createClient().executeFlow(
				'flow-1',
				{ metadata: { directoryId: 'd', directoryName: 'D', directorySlug: 'd', targetItems: 1 } },
				createSettings({ webhookMode: 'async' })
			);

			expect(String(fetchSpy.mock.calls[0]![0])).toContain('/api/v1/webhooks/flow-1');
			expect(String(fetchSpy.mock.calls[0]![0])).not.toContain('/sync');
		});

		it('should extract flowRunId from response', async () => {
			fetchSpy.mockResolvedValue(mockJsonResponse({ runId: 'run-xyz', items: [{ name: 'A' }] }));

			const result = await createClient().executeFlow(
				'flow-1',
				{ metadata: { directoryId: 'd', directoryName: 'D', directorySlug: 'd', targetItems: 1 } },
				createSettings()
			);

			expect(result.flowRunId).toBe('run-xyz');
		});

		it('should respect abort signal', async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				createClient().executeFlow(
					'flow-1',
					{ metadata: { directoryId: 'd', directoryName: 'D', directorySlug: 'd', targetItems: 1 } },
					createSettings(),
					undefined,
					controller.signal
				)
			).rejects.toThrow(/cancelled/);
		});
	});

	describe('ping', () => {
		it('should hit the flows list endpoint', async () => {
			fetchSpy.mockResolvedValue(mockJsonResponse({ data: [], next: null, previous: null }));
			await createClient().ping('proj-1');

			const [url] = fetchSpy.mock.calls[0]!;
			expect(String(url)).toContain('/api/v1/flows');
			expect(String(url)).toContain('projectId=proj-1');
		});
	});
});
