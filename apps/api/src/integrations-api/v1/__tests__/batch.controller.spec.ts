import { IntegrationBatchController, operationPath } from '../batch.controller';

/**
 * `POST /api/integrations/v1/batch` (EW-P1-4): operations run in order over
 * loopback with the outer credential and pin, per-operation headers limited to
 * the contract's list, and paths confined to `/api/integrations/v1`.
 */
describe('IntegrationBatchController', () => {
    const adapterHost = {
        httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4321 }) }) },
    };
    const outer = {
        headers: {
            authorization: 'Bearer ew_int_secret',
            'x-api-key': 'ew_int_other_form',
            'x-scope-slug': 'acme',
            cookie: 'never-forwarded',
        },
    };
    const realFetch = global.fetch;
    let calls: Array<{ url: string; init: RequestInit }>;

    beforeEach(() => {
        calls = [];
        let n = 0;
        global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init: init ?? {} });
            n += 1;
            if (n === 2) return new Response(null, { status: 204 });
            return new Response(JSON.stringify({ id: `r-${n}` }), {
                status: n === 1 ? 201 : 412,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;
    });
    afterAll(() => {
        global.fetch = realFetch;
    });

    it('runs every operation in order and answers one {status, body} each', async () => {
        const controller = new IntegrationBatchController(adapterHost as never);
        const result = await controller.batch(
            {
                operations: [
                    {
                        method: 'POST',
                        path: '/tasks',
                        headers: { 'Idempotency-Key': 'k-1', Cookie: 'x', Authorization: 'other' },
                        body: { title: 'One' },
                    },
                    { method: 'DELETE', path: '/tasks/t-1', headers: { 'If-Match': '"3"' } },
                    { method: 'GET', path: '/tasks?limit=5', body: { ignored: true } },
                ],
            },
            outer,
        );
        expect(result.results).toEqual([
            { status: 201, body: { id: 'r-1' } },
            { status: 204, body: null },
            { status: 412, body: { id: 'r-3' } },
        ]);
        expect(calls.map((call) => [call.init.method, call.url])).toEqual([
            ['POST', 'http://127.0.0.1:4321/api/integrations/v1/tasks'],
            ['DELETE', 'http://127.0.0.1:4321/api/integrations/v1/tasks/t-1'],
            ['GET', 'http://127.0.0.1:4321/api/integrations/v1/tasks?limit=5'],
        ]);
        const first = calls[0].init.headers as Record<string, string>;
        expect(first).toMatchObject({
            authorization: 'Bearer ew_int_secret',
            'x-api-key': 'ew_int_other_form',
            'x-scope-slug': 'acme',
            'idempotency-key': 'k-1',
            'content-type': 'application/json',
        });
        expect(first.cookie).toBeUndefined();
        expect(calls[0].init.body).toBe(JSON.stringify({ title: 'One' }));
        expect((calls[1].init.headers as Record<string, string>)['if-match']).toBe('"3"');
        expect(calls[2].init.body).toBeUndefined();
    });

    it('refuses a path outside /api/integrations/v1, or /batch, before running anything', async () => {
        const controller = new IntegrationBatchController(adapterHost as never);
        await expect(
            controller.batch(
                {
                    operations: [
                        { method: 'GET', path: '/tasks' },
                        { method: 'GET', path: '/../../auth/api-keys' },
                    ],
                },
                outer,
            ),
        ).rejects.toMatchObject({ code: 'validation_failed' });
        expect(calls).toEqual([]);
    });

    it.each([
        ['/batch'],
        ['/BATCH/'],
        ['/%2e%2e/%2e%2e/auth'],
        ['tasks'],
        ['//evil.example.com/x'],
        ['/..\\auth'],
    ])('operationPath refuses %s', (path) => {
        expect(() => operationPath(path, 0)).toThrow();
    });

    it('operationPath keeps a normal path and its query', () => {
        expect(operationPath('/tasks/abc/comments?limit=10', 0)).toBe(
            '/api/integrations/v1/tasks/abc/comments?limit=10',
        );
    });
});
