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
		projectId: 'proj-1',
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

/**
 * Helper that returns successive mocked Responses for each fetch() call,
 * matched by URL substring. Tests can declare expected calls in order.
 */
function queueFetch(sequence: Array<{ urlContains: string; response: Response }>) {
	let i = 0;
	(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => {
		const url = String(args[0]);
		const expected = sequence[i++];
		if (!expected) throw new Error(`Unexpected fetch call (#${i}) to ${url}`);
		if (!url.includes(expected.urlContains)) {
			throw new Error(`Fetch #${i}: expected URL containing "${expected.urlContains}", got "${url}"`);
		}
		return expected.response;
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
			fetchSpy.mockResolvedValue(
				mockJsonResponse({ id: 'flow-1', status: 'ENABLED', publishedVersionId: 'v1' })
			);

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
			fetchSpy.mockResolvedValue(
				mockJsonResponse({ id: 'flow-1', status: 'ENABLED', publishedVersionId: null })
			);

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
			fetchSpy.mockResolvedValue(
				new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
			);
			await expect(createClient().validateFlow('flow-1')).rejects.toThrow(/Invalid Activepieces API key/);
		});

		it('should map 404 to a friendly not-found error', async () => {
			fetchSpy.mockResolvedValue(new Response('not found', { status: 404, statusText: 'Not Found' }));
			await expect(createClient().validateFlow('flow-1')).rejects.toThrow(/not found/);
		});
	});

	describe('getFlowRun', () => {
		it('should hit GET /flow-runs/{id}', async () => {
			fetchSpy.mockResolvedValue(
				mockJsonResponse({ id: 'run-1', flowId: 'flow-1', projectId: 'proj-1', status: 'SUCCEEDED' })
			);

			const run = await createClient().getFlowRun('run-1');

			expect(run.id).toBe('run-1');
			expect(String(fetchSpy.mock.calls[0]![0])).toContain('/api/v1/flow-runs/run-1');
		});
	});

	describe('findLatestRunForFlow', () => {
		it('should query /flow-runs with projectId, flowId, limit=1', async () => {
			fetchSpy.mockResolvedValue(
				mockJsonResponse({
					data: [{ id: 'run-1', flowId: 'flow-1', projectId: 'proj-1', status: 'RUNNING' }],
					next: null,
					previous: null
				})
			);

			const run = await createClient().findLatestRunForFlow('flow-1', 'proj-1');

			expect(run?.id).toBe('run-1');
			const url = String(fetchSpy.mock.calls[0]![0]);
			expect(url).toContain('/api/v1/flow-runs');
			expect(url).toContain('flowId=flow-1');
			expect(url).toContain('projectId=proj-1');
			expect(url).toContain('limit=1');
		});

		it('should return undefined when no runs exist', async () => {
			fetchSpy.mockResolvedValue(mockJsonResponse({ data: [], next: null, previous: null }));
			const run = await createClient().findLatestRunForFlow('flow-1', 'proj-1');
			expect(run).toBeUndefined();
		});
	});

	describe('executeFlow (sync)', () => {
		it('should POST to the sync webhook URL by default', async () => {
			queueFetch([
				{ urlContains: '/webhooks/flow-1/sync', response: mockJsonResponse({ items: [{ name: 'A' }] }) }
			]);

			const result = await createClient().executeFlow(
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

		it('should enrich result with run record when runId is in response', async () => {
			queueFetch([
				{
					urlContains: '/webhooks/flow-1/sync',
					response: mockJsonResponse({ runId: 'run-xyz', items: [{ name: 'A' }] })
				},
				{
					urlContains: '/flow-runs/run-xyz',
					response: mockJsonResponse({
						id: 'run-xyz',
						flowId: 'flow-1',
						projectId: 'proj-1',
						status: 'SUCCEEDED',
						finishTime: '2026-04-29T00:00:00Z'
					})
				}
			]);

			const result = await createClient().executeFlow(
				'flow-1',
				{ metadata: { directoryId: 'd', directoryName: 'D', directorySlug: 'd', targetItems: 1 } },
				createSettings()
			);

			expect(result.flowRunId).toBe('run-xyz');
			expect(result.run?.status).toBe('SUCCEEDED');
			expect(result.run?.finishTime).toBe('2026-04-29T00:00:00Z');
		});

		it('should still succeed if run record fetch fails', async () => {
			queueFetch([
				{
					urlContains: '/webhooks/flow-1/sync',
					response: mockJsonResponse({ runId: 'run-xyz', items: [{ name: 'A' }] })
				},
				{
					urlContains: '/flow-runs/run-xyz',
					response: new Response('boom', { status: 500, statusText: 'Server Error' })
				}
			]);

			const result = await createClient().executeFlow(
				'flow-1',
				{ metadata: { directoryId: 'd', directoryName: 'D', directorySlug: 'd', targetItems: 1 } },
				createSettings()
			);

			expect(result.flowRunId).toBe('run-xyz');
			expect(result.output).toEqual({ runId: 'run-xyz', items: [{ name: 'A' }] });
			expect(result.run).toBeUndefined();
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

	describe('executeFlow (async)', () => {
		it('should POST to async webhook then poll until terminal status', async () => {
			queueFetch([
				{ urlContains: '/webhooks/flow-1', response: mockJsonResponse({}) },
				{
					urlContains: '/flow-runs?',
					response: mockJsonResponse({
						data: [{ id: 'run-1', flowId: 'flow-1', projectId: 'proj-1', status: 'RUNNING' }],
						next: null,
						previous: null
					})
				},
				{
					urlContains: '/flow-runs?',
					response: mockJsonResponse({
						data: [
							{
								id: 'run-1',
								flowId: 'flow-1',
								projectId: 'proj-1',
								status: 'SUCCEEDED',
								steps: { stepOne: { output: { items: [{ name: 'A' }] } } }
							}
						],
						next: null,
						previous: null
					})
				},
				{
					urlContains: '/flow-runs/run-1',
					response: mockJsonResponse({
						id: 'run-1',
						flowId: 'flow-1',
						projectId: 'proj-1',
						status: 'SUCCEEDED',
						steps: { stepOne: { output: { items: [{ name: 'A' }] } } }
					})
				}
			]);

			vi.useFakeTimers({ shouldAdvanceTime: true });
			try {
				const promise = createClient().executeFlow(
					'flow-1',
					{ metadata: { directoryId: 'd', directoryName: 'D', directorySlug: 'd', targetItems: 1 } },
					createSettings({ webhookMode: 'async' })
				);

				await vi.advanceTimersByTimeAsync(5000);
				const result = await promise;

				expect(result.flowRunId).toBe('run-1');
				expect(result.run?.status).toBe('SUCCEEDED');
				expect(String(fetchSpy.mock.calls[0]![0])).not.toContain('/sync');
			} finally {
				vi.useRealTimers();
			}
		});

		it('should reject when projectId is missing in async mode', async () => {
			queueFetch([{ urlContains: '/webhooks/flow-1', response: mockJsonResponse({}) }]);

			await expect(
				createClient().executeFlow(
					'flow-1',
					{ metadata: { directoryId: 'd', directoryName: 'D', directorySlug: 'd', targetItems: 1 } },
					createSettings({ webhookMode: 'async', projectId: undefined })
				)
			).rejects.toThrow(/project id/i);
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
