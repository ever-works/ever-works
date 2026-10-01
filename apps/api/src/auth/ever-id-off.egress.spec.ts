import * as net from 'node:net';
import * as tls from 'node:tls';
import * as request from 'supertest';
import { ExternalIdentity } from '@ever-works/agent/entities';
import { createEverIdHarness, type EverIdHarness } from './__tests__/ever-id-harness.helper-spec';

/**
 * APW-12 (Ever ID) — the "switched off ⇒ zero outbound calls" proof (spec FR-5,
 * NFR-12, US-6; ACC-12-01, ACC-12-04).
 *
 * The API is booted with Ever ID configured against the real stage issuer
 * address, `https://auth-stage.ever.co`, but NOT turned on by an administrator —
 * exactly the posture of an environment that carries the settings and has not
 * been switched on. Every `/api/auth/ever-id/*` route is then called, with and
 * without a session, and every way the process could reach the network is
 * recorded: `globalThis.fetch` (what the identity provider plugin and the
 * platform's HTTP clients use, undici underneath), and the `net` / `tls`
 * connect primitives every Node HTTP client — undici included — ends in.
 * Loopback connections (the test's own requests to the app) are the only ones
 * allowed.
 *
 * The control at the end turns Ever ID on and shows the same recorders DO see a
 * request to the issuer, so a recorder that could not fail cannot pass this spec.
 */
jest.setTimeout(60_000);

const ISSUER = 'https://auth-stage.ever.co';

function isLoopback(host: unknown): boolean {
    const value = typeof host === 'string' ? host : '';
    return (
        value === '' ||
        value === 'localhost' ||
        value === '127.0.0.1' ||
        value === '::1' ||
        value.startsWith('127.')
    );
}

function hostOf(args: unknown[]): string {
    const [first, second] = args as [unknown, unknown];
    if (first && typeof first === 'object') {
        const options = first as { host?: string; hostname?: string; servername?: string };
        return options.host ?? options.hostname ?? options.servername ?? '';
    }
    if (typeof first === 'number' && typeof second === 'string') return second;
    return '';
}

/** A syntactically valid but unsigned logout token naming `iss`. */
function unsignedToken(payload: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'ES256', kid: 'k' })}.${part(payload)}.${Buffer.from('sig').toString('base64url')}`;
}

describe('Ever ID switched off: zero outbound requests', () => {
    let harness: EverIdHarness;
    let fetchCalls: string[];
    let externalConnects: string[];
    const originalFetch = globalThis.fetch;
    const spies: jest.SpyInstance[] = [];

    beforeAll(async () => {
        harness = await createEverIdHarness({
            enabled: false,
            withFakeProvider: false,
            issuerUrl: ISSUER,
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        fetchCalls = [];
        externalConnects = [];
        globalThis.fetch = jest.fn(async (input: unknown) => {
            fetchCalls.push(
                String(
                    input instanceof URL ? input.href : ((input as { url?: string })?.url ?? input),
                ),
            );
            throw new Error('outbound request blocked by the egress spec');
        }) as unknown as typeof fetch;
        for (const [module, method] of [
            [net, 'connect'],
            [net, 'createConnection'],
            [tls, 'connect'],
        ] as const) {
            const original = (module as unknown as Record<string, (...args: unknown[]) => unknown>)[
                method
            ];
            spies.push(
                jest.spyOn(module as never, method as never).mockImplementation(((
                    ...args: unknown[]
                ) => {
                    const host = hostOf(args);
                    if (!isLoopback(host)) externalConnects.push(`${method}:${host}`);
                    return original.apply(module, args);
                }) as never),
            );
        }
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        while (spies.length) spies.pop()?.mockRestore();
    });

    it('answers every route without a single request leaving the process', async () => {
        const app = harness.app.getHttpServer();
        const person = await harness.createUser({ email: 'person@example.com' });
        const admin = await harness.createUser({
            email: 'admin@example.com',
            isPlatformAdmin: false,
        });
        const session = await harness.sessionFor(person.id);
        const adminSession = await harness.sessionFor(admin.id);
        const logoutToken = unsignedToken({
            iss: ISSUER,
            sid: 'some-sid',
            jti: 'j1',
            iat: Math.floor(Date.now() / 1000),
        });

        const signInFamily = [
            await request(app).post('/api/auth/ever-id/authorize').send({ returnTo: '/works' }),
            await request(app)
                .post('/api/auth/ever-id/callback')
                .send({ code: 'code', state: 'state', iss: ISSUER, transaction: 'sealed' }),
            await request(app)
                .post('/api/auth/ever-id/sign-up/confirm')
                .send({ pending: 'sealed', terms: [] }),
            await request(app)
                .post('/api/auth/ever-id/connect/authorize')
                .set('Authorization', `Bearer ${session}`)
                .send({}),
            await request(app)
                .post('/api/auth/ever-id/connect/confirm')
                .set('Authorization', `Bearer ${session}`)
                .send({ pending: 'sealed' }),
            await request(app)
                .post('/api/auth/ever-id/session')
                .set('Authorization', 'Bearer a.b.c')
                .send(),
            await request(app).get('/api/auth/ever-id/client-config'),
        ];
        for (const response of signInFamily) {
            expect({ status: response.status, code: response.body.code }).toEqual({
                status: 404,
                code: 'ever_id_disabled',
            });
        }

        // Listing works while off (ACC-12-04); the sign-out address is simply absent.
        const identities = await request(app)
            .get('/api/auth/ever-id/identities')
            .set('Authorization', `Bearer ${session}`);
        expect(identities.status).toBe(200);
        expect(identities.body.items).toEqual([]);
        const logoutUrl = await request(app)
            .get('/api/auth/ever-id/logout-url')
            .set('Authorization', `Bearer ${session}`);
        expect(logoutUrl.status).toBe(404);
        const disconnect = await request(app)
            .delete('/api/auth/ever-id/identities/00000000-0000-4000-8000-000000000000')
            .set('Authorization', `Bearer ${session}`);
        expect(disconnect.status).toBe(404);

        // A sign-out notice for an installation that never connected anyone is
        // acknowledged without fetching the provider's keys (S26).
        const notice = await request(app)
            .post('/api/auth/ever-id/backchannel-logout')
            .type('form')
            .send({ logout_token: logoutToken });
        expect(notice.status).toBe(200);
        expect(notice.headers['cache-control']).toBe('no-store');

        // Admin routes are invisible to a non-admin and do nothing.
        for (const [method, path] of [
            ['post', '/api/auth/ever-id/admin/test'],
            ['get', '/api/auth/ever-id/admin/health'],
            ['get', '/api/auth/ever-id/admin/status'],
            ['post', '/api/auth/ever-id/admin/enable'],
        ] as const) {
            const response = await (request(app) as any)
                [method](path)
                .set('Authorization', `Bearer ${adminSession}`);
            expect(response.status).toBe(404);
        }

        // A delegated token on the marked handler is refused without verification.
        const delegated = await request(app)
            .get('/api/test-delegated/marked')
            .set('Authorization', 'Bearer a.b.c');
        expect(delegated.status).toBe(401);

        expect(fetchCalls).toEqual([]);
        expect(externalConnects).toEqual([]);
        expect(await harness.dataSource.getRepository(ExternalIdentity).count()).toBe(0);
    });

    it('control: once an administrator turns Ever ID on, the same recorders see the request to the issuer', async () => {
        await harness.setEnabled(true);
        try {
            const response = await request(harness.app.getHttpServer())
                .post('/api/auth/ever-id/authorize')
                .send({});

            // The blocked fetch surfaces as "provider not responding" — and was recorded.
            expect(response.status).toBe(503);
            expect(response.body.code).toBe('provider_unavailable');
            expect(fetchCalls.some((url) => url.startsWith(`${ISSUER}/`))).toBe(true);
        } finally {
            await harness.setEnabled(false);
        }
    });
});
