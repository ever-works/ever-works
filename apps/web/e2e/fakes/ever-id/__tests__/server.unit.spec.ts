/**
 * APW-12 (Ever ID) — the fixture provider the Playwright lane starts before the API
 * (`../server.mjs`, T48).
 *
 * What the `ever-id-*` suites rely on, driven through the real HTTP servers on
 * ephemeral ports:
 *
 *   1. the provider answers discovery at the issuer it reports, and that issuer is the
 *      `http://localhost:<port>` spelling the lane configures the API with;
 *   2. the control routes set the person, the extra claims and the session id the next
 *      tokens carry, and mint access tokens;
 *   3. `/_control/calls` records provider requests by method and path only;
 *   4. unknown control routes answer 404, and `stop()` closes both servers.
 *
 * It needs the `oidc-identity` package built (its `dist/testing` entry), like the lane.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Plain ESM test infrastructure; `allowJs` lets TypeScript infer its surface.
import { DEFAULT_CLIENT_SECRET, DEFAULT_PORT, createEverIdFake } from '../server.mjs';

type Fake = Awaited<ReturnType<typeof createEverIdFake>>;

let fake: Fake;

async function control(path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${fake.controlUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
}

function payloadOf(jwt: string): Record<string, unknown> {
    const [, payload] = jwt.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

beforeAll(async () => {
    fake = await createEverIdFake({ port: 0, controlPort: 0 });
});

afterAll(async () => {
    await fake?.stop();
});

describe('the Ever ID fixture provider', () => {
    it('keeps the lane defaults the workflow configures the API with', () => {
        expect(DEFAULT_PORT).toBe(3950);
        expect(DEFAULT_CLIENT_SECRET).toBe('e2e-ever-id-client-secret-not-real');
    });

    it('answers discovery at the issuer it reports, spelled http://localhost:<port>', async () => {
        expect(fake.issuer).toMatch(/^http:\/\/localhost:\d+$/);
        const health = await control('/_control/health');
        expect(health).toEqual({ status: 200, json: { status: 'ok', issuer: fake.issuer } });

        const port = new URL(fake.issuer).port;
        const discovery = await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`);
        expect(discovery.status).toBe(200);
        const document = (await discovery.json()) as Record<string, unknown>;
        expect(document.issuer).toBe(fake.issuer);
        expect(document.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('records provider requests by method and path only', async () => {
        const { json } = await control('/_control/calls');
        const calls = json.calls as Array<Record<string, unknown>>;
        expect(calls).toContainEqual({ method: 'GET', path: '/.well-known/openid-configuration' });
        for (const call of calls) {
            expect(Object.keys(call).sort()).toEqual(['method', 'path']);
        }
    });

    it('sets the next person, extra claims and session id, and mints access tokens', async () => {
        expect(
            (
                await control('/_control/user', {
                    subject: 'sub-1',
                    email: 'one@test.local',
                    emailVerified: true,
                })
            ).status,
        ).toBe(200);
        expect((await control('/_control/claims', { 'urn:ever:claims_ver': 1 })).status).toBe(200);
        expect((await control('/_control/sid', { sid: 'sid-1' })).status).toBe(200);

        const minted = await control('/_control/mint-access', {
            subject: 'sub-1',
            scopes: ['apps:read'],
            authorizedParty: 'ever-apps-host',
        });
        expect(minted.status).toBe(200);
        const claims = payloadOf(minted.json.token);
        expect(claims).toMatchObject({ iss: fake.issuer, sub: 'sub-1', azp: 'ever-apps-host' });
        expect(String(claims.scope)).toContain('apps:read');
    });

    it('answers 404 to an unknown control route', async () => {
        expect((await control('/_control/nope', {})).status).toBe(404);
        expect((await control('/_control/nope')).status).toBe(404);
    });
});
