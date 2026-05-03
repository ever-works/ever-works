import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MakeClient } from '../utils/make-client.js';
import type { MakeSettings, MakeWorkflowInput } from '../types.js';

interface MockResponseInit {
	status?: number;
	statusText?: string;
	body?: unknown;
}

function mockResponse(init: MockResponseInit = {}): Response {
	const status = init.status ?? 200;
	const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {});
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: init.statusText ?? 'OK',
		text: () => Promise.resolve(body)
	} as unknown as Response;
}

function createClient(overrides?: Record<string, unknown>): MakeClient {
	return new MakeClient({
		apiKey: 'test-api-key',
		baseUrl: 'https://us2.make.com/api/v2',
		logger: { log: vi.fn(), warn: vi.fn() },
		...(overrides as Record<string, unknown>)
	} as ConstructorParameters<typeof MakeClient>[0]);
}

function createSettings(overrides?: Partial<MakeSettings>): MakeSettings {
	return {
		apiKey: 'test-api-key',
		baseUrl: 'https://us2.make.com/api/v2',
		executionMode: 'scenario',
		timeoutMs: 60_000,
		pollIntervalMs: 10,
		maxPollAttempts: 5,
		...overrides
	};
}

function createInput(): MakeWorkflowInput {
	return {
		metadata: {
			workId: 'dir-1',
			workName: 'Test',
			workSlug: 'test',
			targetItems: 50
		}
	};
}

describe('MakeClient', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('request / auth', () => {
		it('should send Bearer-style Token auth header and JSON content type', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
			const client = createClient();

			await client.whoAmI();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://us2.make.com/api/v2/users/me');
			expect((init as RequestInit).headers).toMatchObject({
				Authorization: 'Token test-api-key',
				'Content-Type': 'application/json',
				Accept: 'application/json'
			});
		});

		it('should wrap 401 with a friendly message', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ status: 401, statusText: 'Unauthorized', body: { message: 'bad token' } })
			);
			const client = createClient();

			await expect(client.whoAmI()).rejects.toThrow('Invalid Make.com API key');
		});

		it('should wrap 404 with a friendly message', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ status: 404, statusText: 'Not Found', body: { message: 'scenario missing' } })
			);
			const client = createClient();

			await expect(client.getScenario('nope')).rejects.toThrow('Make.com resource not found');
		});

		it('should wrap 429 rate limit error', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ status: 429, statusText: 'Too Many Requests' }));
			const client = createClient();

			await expect(client.whoAmI()).rejects.toThrow('rate limit exceeded');
		});

		it('should wrap 500 as service error', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ status: 500, statusText: 'Internal Error', body: { message: 'boom' } })
			);
			const client = createClient();

			await expect(client.whoAmI()).rejects.toThrow('service error');
		});
	});

	describe('listScenarios', () => {
		it('should request /scenarios and return the array', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: { scenarios: [{ id: 1, name: 'Scenario A', isActive: true }] }
				})
			);
			const client = createClient();

			const scenarios = await client.listScenarios();

			expect(scenarios).toEqual([{ id: 1, name: 'Scenario A', isActive: true }]);
			const [url] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://us2.make.com/api/v2/scenarios');
		});

		it('should include teamId in the query when configured', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: { scenarios: [] } }));
			const client = createClient({ teamId: '42' });

			await client.listScenarios();

			const [url] = fetchMock.mock.calls[0];
			expect(String(url)).toContain('teamId=42');
		});

		it('should return an empty array when the response has no scenarios field', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
			const client = createClient();

			const scenarios = await client.listScenarios();
			expect(scenarios).toEqual([]);
		});
	});

	describe('getScenario / validateScenario', () => {
		it('should throw when scenario is not returned', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
			const client = createClient();

			await expect(client.getScenario(99)).rejects.toThrow('not found');
		});

		it('should throw when scenario is inactive', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: { scenario: { id: 1, name: 'Paused One', isActive: false } }
				})
			);
			const client = createClient();

			await expect(client.validateScenario(1)).rejects.toThrow('not active');
		});

		it('should warn when scenario is paused but still return it', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({
					body: { scenario: { id: 1, name: 'Paused', isActive: true, isPaused: true } }
				})
			);
			const warn = vi.fn();
			const client = createClient({ logger: { log: vi.fn(), warn } });

			const scenario = await client.validateScenario(1);

			expect(scenario.id).toBe(1);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('paused'));
		});

		it('should return scenario when active', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { scenario: { id: 7, name: 'Live', isActive: true } } })
			);
			const client = createClient();

			const scenario = await client.validateScenario(7);
			expect(scenario.name).toBe('Live');
		});
	});

	describe('runScenario', () => {
		it('should POST to /scenarios/{id}/run with the input', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: { executionId: 'exec-1', status: 'running' } }));
			const client = createClient();

			const response = await client.runScenario(42, createInput());

			expect(response.executionId).toBe('exec-1');
			const [url, init] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://us2.make.com/api/v2/scenarios/42/run');
			expect((init as RequestInit).method).toBe('POST');
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body.data.metadata.workId).toBe('dir-1');
			expect(body.responsive).toBe(true);
		});
	});

	describe('pollExecution', () => {
		it('should resolve when status becomes success and return attempt count', async () => {
			fetchMock
				.mockResolvedValueOnce(mockResponse({ body: { execution: { status: 'running' } } }))
				.mockResolvedValueOnce(
					mockResponse({ body: { execution: { status: 'success', output: { items: [] } } } })
				);

			const client = createClient();
			const onProgress = vi.fn();

			const result = await client.pollExecution(1, 'exec-1', createSettings(), onProgress);

			expect(result.status.status).toBe('success');
			expect(result.attempts).toBe(2);
			expect(onProgress).toHaveBeenCalledTimes(2);
			expect(onProgress).toHaveBeenLastCalledWith(2, 'success');
		});

		it('should return attempts=1 when scenario succeeds on the first poll', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { execution: { status: 'success', output: { items: [] } } } })
			);

			const client = createClient();
			const result = await client.pollExecution(1, 'exec-1', createSettings());

			expect(result.status.status).toBe('success');
			expect(result.attempts).toBe(1);
		});

		it('should throw on error status with provided error message', async () => {
			fetchMock.mockResolvedValueOnce(
				mockResponse({ body: { execution: { status: 'error', error: 'scenario blew up' } } })
			);
			const client = createClient();

			await expect(client.pollExecution(1, 'exec-1', createSettings())).rejects.toThrow('scenario blew up');
		});

		it('should throw on "failed" status', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: { execution: { status: 'failed' } } }));
			const client = createClient();

			await expect(client.pollExecution(1, 'exec-1', createSettings())).rejects.toThrow('failed');
		});

		it('should respect maxPollAttempts', async () => {
			fetchMock.mockResolvedValue(mockResponse({ body: { execution: { status: 'running' } } }));
			const client = createClient();

			await expect(
				client.pollExecution(1, 'exec-1', createSettings({ maxPollAttempts: 2, pollIntervalMs: 1 }))
			).rejects.toThrow('did not complete');
		});

		it('should abort when signal is triggered mid-poll', async () => {
			fetchMock.mockResolvedValue(mockResponse({ body: { execution: { status: 'running' } } }));
			const client = createClient();
			const controller = new AbortController();
			controller.abort();

			await expect(
				client.pollExecution(1, 'exec-1', createSettings(), undefined, controller.signal)
			).rejects.toThrow('cancelled');
		});
	});

	describe('hooks', () => {
		it('should list hooks and include teamId when set', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: { hooks: [{ id: 1, name: 'My Hook' }] } }));
			const client = createClient({ teamId: '7' });

			const hooks = await client.listHooks();

			expect(hooks).toHaveLength(1);
			const [url] = fetchMock.mock.calls[0];
			expect(String(url)).toContain('teamId=7');
		});

		it('should get a single hook', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: { hook: { id: 11, name: 'A Hook' } } }));
			const client = createClient();

			const hook = await client.getHook(11);
			expect(hook.name).toBe('A Hook');
		});

		it('should throw when hook is missing', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
			const client = createClient();

			await expect(client.getHook(99)).rejects.toThrow('not found');
		});

		it('should ping a hook', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
			const client = createClient();

			await expect(client.pingHook(11)).resolves.toBeUndefined();
			const [url] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://us2.make.com/api/v2/hooks/11/ping');
		});
	});

	describe('invokeWebhook', () => {
		it('should POST JSON to the webhook URL and parse the response', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: { items: [{ name: 'Hook Item' }] } }));
			const client = createClient();

			const result = (await client.invokeWebhook('https://hook.us2.make.com/xyz', createInput())) as {
				items: Array<{ name: string }>;
			};

			expect(result.items[0].name).toBe('Hook Item');
			const [url, init] = fetchMock.mock.calls[0];
			expect(String(url)).toBe('https://hook.us2.make.com/xyz');
			expect((init as RequestInit).method).toBe('POST');
			expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' });
		});

		it('should return raw text when response is not JSON', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ body: 'Accepted' }));
			const client = createClient();

			const result = await client.invokeWebhook('https://hook.us2.make.com/xyz', createInput());
			expect(result).toBe('Accepted');
		});

		it('should throw when webhook returns an error status', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ status: 500, statusText: 'Internal Error', body: 'boom' }));
			const client = createClient();

			await expect(client.invokeWebhook('https://hook.us2.make.com/xyz', createInput())).rejects.toThrow('500');
		});

		it('should explain 401 with actionable guidance', async () => {
			fetchMock.mockResolvedValueOnce(mockResponse({ status: 401, statusText: 'Unauthorized', body: 'nope' }));
			const client = createClient();

			await expect(client.invokeWebhook('https://hook.us2.make.com/xyz', createInput())).rejects.toThrow(
				/scenario tied to this webhook is active/
			);
		});
	});
});
