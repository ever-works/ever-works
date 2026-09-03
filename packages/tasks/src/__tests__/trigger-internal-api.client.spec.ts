import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import superjson from 'superjson';

const { triggerConfig } = vi.hoisted(() => ({
    triggerConfig: {
        getInternalBaseUrl: vi.fn(),
        getInternalSecret: vi.fn(),
        getInternalRequestTimeoutMs: vi.fn(),
    },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: triggerConfig,
    },
}));

import { TriggerInternalApiClient } from '../trigger/worker/services/trigger-internal-api.client';

const okJsonResponse = (status: number, body: unknown): Response =>
    ({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
    }) as unknown as Response;

const okEmptyResponse = (status = 204): Response =>
    ({
        ok: true,
        status,
        text: () => Promise.resolve(''),
    }) as unknown as Response;

const errorResponse = (status: number, body = 'boom'): Response =>
    ({
        ok: false,
        status,
        text: () => Promise.resolve(body),
    }) as unknown as Response;

describe('TriggerInternalApiClient', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com/');
        triggerConfig.getInternalSecret.mockReturnValue('secret-1');
        triggerConfig.getInternalRequestTimeoutMs.mockReturnValue(45000);

        fetchSpy = vi.fn();
        // @ts-expect-error - install fetch on global
        globalThis.fetch = fetchSpy;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('constructor', () => {
        it('throws when TRIGGER_INTERNAL_API_URL is not configured', () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('');
            triggerConfig.getInternalSecret.mockReturnValue('s');

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_API_URL is not configured',
            );
        });

        it('throws when TRIGGER_INTERNAL_API_URL is null/undefined (treated as empty)', () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue(undefined as unknown as string);
            triggerConfig.getInternalSecret.mockReturnValue('s');

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_API_URL is not configured',
            );
        });

        it('throws when TRIGGER_INTERNAL_SECRET is not configured', () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com');
            triggerConfig.getInternalSecret.mockReturnValue('');

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_SECRET is not configured',
            );
        });

        it('throws when TRIGGER_INTERNAL_SECRET is null/undefined', () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com');
            triggerConfig.getInternalSecret.mockReturnValue(undefined as unknown as string);

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_SECRET is not configured',
            );
        });

        it('constructs successfully when both env values are present', () => {
            expect(() => new TriggerInternalApiClient()).not.toThrow();
        });
    });

    describe('constructor — HTTPS enforcement', () => {
        const originalNodeEnv = process.env.NODE_ENV;

        afterEach(() => {
            process.env.NODE_ENV = originalNodeEnv;
        });

        it('throws in production when the base URL is plaintext http:// on a PUBLIC host', () => {
            process.env.NODE_ENV = 'production';
            triggerConfig.getInternalBaseUrl.mockReturnValue('http://api.example.com:3100');
            triggerConfig.getInternalSecret.mockReturnValue('s');

            expect(() => new TriggerInternalApiClient()).toThrow(
                'TRIGGER_INTERNAL_API_URL must use HTTPS',
            );
        });

        it('allows https:// in production', () => {
            process.env.NODE_ENV = 'production';
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.internal:3100');
            triggerConfig.getInternalSecret.mockReturnValue('s');

            expect(() => new TriggerInternalApiClient()).not.toThrow();
        });

        it('allows plaintext http:// to an in-cluster host in production (trusted pod network)', () => {
            process.env.NODE_ENV = 'production';
            triggerConfig.getInternalSecret.mockReturnValue('s');

            for (const url of [
                'http://ever-works-api.ever-works-app-prod.svc.cluster.local:3100/internal/trigger',
                'http://ever-works-api:3100',
                'http://localhost:3100',
                'http://10.42.1.7:3100',
            ]) {
                triggerConfig.getInternalBaseUrl.mockReturnValue(url);
                expect(() => new TriggerInternalApiClient()).not.toThrow();
            }
        });

        it('still allows plaintext http:// outside production (local dev / in-cluster)', () => {
            process.env.NODE_ENV = 'development';
            triggerConfig.getInternalBaseUrl.mockReturnValue('http://api:3100');
            triggerConfig.getInternalSecret.mockReturnValue('s');

            expect(() => new TriggerInternalApiClient()).not.toThrow();
        });
    });

    describe('URL composition', () => {
        it('strips a trailing slash on the base URL and a leading slash on the path', async () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com/');
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            await client.fetchWorkContext('w1', 'u1');

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [url] = fetchSpy.mock.calls[0];
            expect(url).toBe('https://api.example.com/works/w1/context?userId=u1');
        });

        it('joins paths with no double-slash when base has no trailing slash', async () => {
            triggerConfig.getInternalBaseUrl.mockReturnValue('https://api.example.com');
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            await client.fetchWorkContext('w1', 'u1');

            const [url] = fetchSpy.mock.calls[0];
            expect(url).toBe('https://api.example.com/works/w1/context?userId=u1');
        });

        it('encodes the userId via URLSearchParams (handles characters that need encoding)', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            await client.fetchWorkContext('work-1', 'user with spaces & symbols');

            const [url] = fetchSpy.mock.calls[0];
            expect(url).toContain('userId=user+with+spaces+%26+symbols');
        });
    });

    describe('fetchWorkContext', () => {
        it('issues a GET to /works/:workId/context?userId=:userId with auth header', async () => {
            const client = new TriggerInternalApiClient();
            const expected = { user: { id: 'u1' }, work: { id: 'w1' }, gitToken: 'tok' };
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, expected));

            const result = await client.fetchWorkContext('w1', 'u1');

            expect(result).toEqual(expected);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [, init] = fetchSpy.mock.calls[0];
            expect(init).toMatchObject({
                method: 'GET',
                headers: {
                    'content-type': 'application/json',
                    'x-trigger-secret': 'secret-1',
                },
            });
            expect(init.body).toBeUndefined();
        });

        it('returns undefined for a 204 No Content response', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okEmptyResponse(204));

            const result = await client.fetchWorkContext('w1', 'u1');

            expect(result).toBeUndefined();
        });

        it('returns undefined for a 200 with empty body', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okEmptyResponse(200));

            const result = await client.fetchWorkContext('w1', 'u1');

            expect(result).toBeUndefined();
        });
    });

    describe('callRemote', () => {
        it('issues a POST to /remote/call with the SuperJSON args envelope', async () => {
            const client = new TriggerInternalApiClient();

            // Server returns a SuperJSON-serialized envelope; the client deserializes it.
            const serverPayload = superjson.serialize({ value: 42, when: new Date('2026-01-01') });
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { result: serverPayload }));

            const result = await client.callRemote('SomeService', 'doIt', {
                json: { foo: 'bar' },
            });

            expect(result).toEqual({ value: 42, when: new Date('2026-01-01') });
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            const [url, init] = fetchSpy.mock.calls[0];
            expect(url).toBe('https://api.example.com/remote/call');
            expect(init.method).toBe('POST');
            expect(JSON.parse(init.body)).toEqual({
                name: 'SomeService',
                method: 'doIt',
                args: { json: { foo: 'bar' } },
            });
        });

        it('forwards SuperJSON meta inside the args envelope', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(
                okJsonResponse(200, { result: superjson.serialize('ok') }),
            );

            await client.callRemote('S', 'm', {
                json: { d: 'pretend-date' },
                meta: { values: { d: ['Date'] } },
            });

            const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(body.args.meta).toEqual({ values: { d: ['Date'] } });
        });

        it('returns undefined when the server omits a `result` field', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, {}));

            const result = await client.callRemote('S', 'm', { json: null });

            expect(result).toBeUndefined();
        });
    });

    describe('retry behaviour', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        const flushAll = async () => {
            // Drain pending microtasks + timers in lock-step so the retry loop can
            // progress without us having to know the exact backoff schedule.
            for (let i = 0; i < 10; i++) {
                await vi.advanceTimersByTimeAsync(2000);
            }
        };

        it('retries once on a 5xx response then resolves on success', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy
                .mockResolvedValueOnce(errorResponse(500, 'down'))
                .mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            const promise = client.fetchWorkContext('w', 'u');
            await flushAll();
            const result = await promise;

            expect(result).toEqual({ ok: true });
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it('retries up to 3 times on persistent 5xx and throws the last status/text', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(503, 'unavailable'));

            const promise = client.fetchWorkContext('w', 'u');
            // Swallow the rejection here so the unhandled-rejection plugin in
            // vitest does not fail the test before we explicitly assert.
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow(
                'Trigger internal API request failed (503): unavailable',
            );
            // initial + 3 retries = 4 fetch calls
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        it('does NOT retry on 4xx — throws immediately after the first attempt', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(errorResponse(404, 'not found'));

            const promise = client.fetchWorkContext('w', 'u');
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow(
                'Trigger internal API request failed (404): not found',
            );
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('retries on a network error (fetch rejects) up to 3 times', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

            const promise = client.fetchWorkContext('w', 'u');
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('ECONNREFUSED');
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        it('coerces non-Error fetch rejections into Error instances before the retry loop continues', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockRejectedValue('string-rejection');

            const promise = client.fetchWorkContext('w', 'u');
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('string-rejection');
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        // ── Billing safety of the retry allow-list ──────────────────────
        //
        // `RETRY_SAFE_REMOTE_METHODS` is a default-DENY list, and the cost of a
        // wrong entry is asymmetric: a missing entry loses one retry, a wrong
        // entry silently doubles a charge. `WorkScheduleService.markRunCompleted`
        // ends in `UsageLedgerService.recordUsage`, which INSERTs a ledger row
        // and calls `BillingProvider.recordUsageCharge` with no dedup and no
        // UNIQUE constraint on `generationHistoryId` — so re-issuing it bills a
        // `billingMode: USAGE` customer twice. These two tests pin the split, so
        // re-adding it to the allow-list turns red here instead of on an invoice.
        const remoteArgs = superjson.serialize([{ scheduleId: 's-1' }]) as {
            json: unknown;
            meta?: unknown;
        };

        it('does NOT retry WorkScheduleService.markRunCompleted — it bills on every call', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(500, 'down'));

            const promise = client.callRemote(
                'WorkScheduleService',
                'markRunCompleted',
                remoteArgs,
            );
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow(
                'Trigger internal API request failed (500): down',
            );
            // Exactly one attempt: a 504 after the API already ran the write
            // must NOT re-issue it. No retries, no second ledger row.
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('DOES retry WorkScheduleService.markRunFailed — it carries an already-marked guard', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(500, 'down'));

            const promise = client.callRemote('WorkScheduleService', 'markRunFailed', remoteArgs);
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow(
                'Trigger internal API request failed (500): down',
            );
            // initial + 3 retries = 4
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        it('uses exponential backoff (500ms, 1000ms, 2000ms) between retries', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy
                .mockResolvedValueOnce(errorResponse(500))
                .mockResolvedValueOnce(errorResponse(500))
                .mockResolvedValueOnce(errorResponse(500))
                .mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            const promise = client.fetchWorkContext('w', 'u');

            // First attempt fires synchronously
            await Promise.resolve();
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // Backoff before attempt 2 = 500ms
            await vi.advanceTimersByTimeAsync(499);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchSpy).toHaveBeenCalledTimes(2);

            // Backoff before attempt 3 = 1000ms
            await vi.advanceTimersByTimeAsync(999);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchSpy).toHaveBeenCalledTimes(3);

            // Backoff before attempt 4 = 2000ms
            await vi.advanceTimersByTimeAsync(1999);
            expect(fetchSpy).toHaveBeenCalledTimes(3);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchSpy).toHaveBeenCalledTimes(4);

            const result = await promise;
            expect(result).toEqual({ ok: true });
        });
    });

    describe('request deadline', () => {
        /** A fetch that never settles on its own — only the abort ends it. */
        const hangUntilAborted = (init: { signal: AbortSignal }) =>
            new Promise<Response>((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    const err = new Error('This operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });

        it('passes an AbortSignal to fetch on every request', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            await client.fetchWorkContext('w', 'u');

            const [, init] = fetchSpy.mock.calls[0];
            expect(init.signal).toBeInstanceOf(AbortSignal);
            expect(init.signal.aborted).toBe(false);
        });

        it('aborts the request once the configured deadline elapses and names the budget', async () => {
            vi.useFakeTimers();
            const client = new TriggerInternalApiClient();
            fetchSpy.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
                hangUntilAborted(init),
            );

            // A non-retry-safe method, so this is a single attempt.
            const promise = client.callRemote('AgentRunService', 'execute', { json: [] });
            promise.catch(() => undefined);

            await vi.advanceTimersByTimeAsync(44999);
            expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(1);

            await expect(promise).rejects.toThrow(
                'Trigger internal API request timed out after 45000ms',
            );
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('honours a custom timeout from config', async () => {
            vi.useFakeTimers();
            triggerConfig.getInternalRequestTimeoutMs.mockReturnValue(1000);
            const client = new TriggerInternalApiClient();
            fetchSpy.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
                hangUntilAborted(init),
            );

            const promise = client.callRemote('AgentRunService', 'execute', { json: [] });
            promise.catch(() => undefined);
            await vi.advanceTimersByTimeAsync(1000);

            await expect(promise).rejects.toThrow(
                'Trigger internal API request timed out after 1000ms',
            );
        });

        it('clears the deadline once the response lands, so a slow later call is unaffected', async () => {
            vi.useFakeTimers();
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValueOnce(okJsonResponse(200, { ok: true }));

            await client.fetchWorkContext('w', 'u');
            const { signal } = fetchSpy.mock.calls[0][1];

            // Well past the deadline: a leaked timer would abort a settled request.
            await vi.advanceTimersByTimeAsync(120_000);

            expect(signal.aborted).toBe(false);
        });

        it('reports a genuine network error unchanged rather than as a timeout', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            await expect(
                client.callRemote('AgentRunService', 'execute', { json: [] }),
            ).rejects.toThrow('ECONNREFUSED');
        });
    });

    describe('retry safety — non-idempotent remote calls are never re-issued', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        const flushAll = async () => {
            for (let i = 0; i < 10; i++) {
                await vi.advanceTimersByTimeAsync(2000);
            }
        };

        // The dangerous case: an entire billed agent loop with real tool side
        // effects. Re-issuing it starts a SECOND run of work the API is very
        // likely still executing.
        it('does NOT retry AgentRunService.execute on a 5xx', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(503, 'unavailable'));

            const promise = client.callRemote('AgentRunService', 'execute', { json: [] });
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow(
                'Trigger internal API request failed (503): unavailable',
            );
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        // A proxy timeout is the exact signature this guard exists for: nginx
        // answers 504 (and Cloudflare 524) while the work keeps running on the
        // API pod, so the status code alone must not authorise a retry.
        it('does NOT retry AgentRunService.execute on a 504 gateway timeout', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(504, 'gateway timeout'));

            const promise = client.callRemote('AgentRunService', 'execute', { json: [] });
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('(504)');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('does NOT retry AgentRunService.execute on a network error', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockRejectedValue(new Error('ECONNRESET'));

            const promise = client.callRemote('AgentRunService', 'execute', { json: [] });
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('ECONNRESET');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['TaskWorkspaceService', 'finalizeRun'],
            ['TaskChatService', 'post'],
            ['RunDispatchGateService', 'drainForWork'],
            ['AgentRunRepository', 'createQueued'],
            ['AgentRepository', 'incrementErrorCount'],
            ['TaskGateRunnerService', 'runChecks'],
            ['TaskGateJudgeService', 'judge'],
            ['NotificationChannelFacadeService', 'deliverToChannelOrThrow'],
            // Sibling of the allow-listed `updateTelemetry`, but it accumulates.
            ['AgentRunRepository', 'addTokens'],
        ])('does NOT retry %s.%s', async (name, method) => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(500, 'down'));

            const promise = client.callRemote(name, method, { json: [] });
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('(500)');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it.each([
            // Pure reads.
            ['AgentRepository', 'findByIdAndUser'],
            ['AgentRunRepository', 'findById'],
            ['TasksService', 'getOne'],
            ['WorkRepository', 'findById'],
            ['AgentRunService', 'checkBudget'],
            // Structurally idempotent writers.
            ['AgentRunRepository', 'markStarted'],
            ['AgentRunRepository', 'markCompleted'],
            ['AgentRunRepository', 'updateTelemetry'],
            ['TaskRunDenormService', 'recordTerminal'],
            ['AgentEscalationService', 'record'],
        ])('DOES retry the declared-safe %s.%s', async (name, method) => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(503, 'unavailable'));

            const promise = client.callRemote(name, method, { json: [] });
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('(503)');
            // initial + 3 retries
            expect(fetchSpy).toHaveBeenCalledTimes(4);
        });

        it('still resolves a declared-safe call that succeeds on a later attempt', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy
                .mockResolvedValueOnce(errorResponse(500, 'down'))
                .mockResolvedValueOnce(
                    okJsonResponse(200, { result: superjson.serialize('recovered') }),
                );

            const promise = client.callRemote('AgentRunRepository', 'markStarted', { json: [] });
            await flushAll();

            await expect(promise).resolves.toBe('recovered');
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        it('never retries a 4xx, even for a declared-safe method', async () => {
            const client = new TriggerInternalApiClient();
            fetchSpy.mockResolvedValue(errorResponse(400, 'bad request'));

            const promise = client.callRemote('AgentRunRepository', 'findById', { json: [] });
            promise.catch(() => undefined);
            await flushAll();

            await expect(promise).rejects.toThrow('(400)');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
    });
});
