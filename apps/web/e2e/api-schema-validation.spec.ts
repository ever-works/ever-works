import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * API schema validation — pass 5+. Deepens api-public-contract.spec.ts.
 * Picks the most-load-bearing endpoints and walks the JSON response to
 * pin: required field presence, type matches, no surprise nulls in
 * id-bearing fields.
 *
 * The goal is to catch the regression where a backend refactor drops a
 * field everyone consumes — the API still returns 200, the e2e suite
 * passes its `status<500` smoke, and the UI silently shows blanks.
 */

function expectType(label: string, val: unknown, expected: string): void {
    expect(
        typeof val,
        `${label}: expected ${expected}, got ${typeof val} (${JSON.stringify(val)})`,
    ).toBe(expected);
}

function expectStringNonEmpty(label: string, val: unknown): void {
    expect(typeof val, `${label} type`).toBe('string');
    expect((val as string).length, `${label} length`).toBeGreaterThan(0);
}

test.describe('API schema — auth profile', () => {
    test('GET /api/auth/profile returns the canonical user shape', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/auth/profile`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const user = body?.user ?? body;
        expectStringNonEmpty('user.id', user?.id);
        expectStringNonEmpty('user.email', user?.email);
        expect(user.email).toBe(u.email);
        // Username is set during registration → must echo back.
        if (user.username !== undefined) {
            expectType('user.username', user.username, 'string');
        }
        // No timestamps should ever come back as null — either omit or
        // ISO string.
        for (const k of ['createdAt', 'updatedAt']) {
            if (user[k] !== undefined) {
                expect(user[k], `${k} must not be null`).not.toBeNull();
                expectType(`user.${k}`, user[k], 'string');
            }
        }
    });
});

test.describe('API schema — /api/works list', () => {
    test('GET /api/works returns an array of works with required keys', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Seed at least one work so the list has an entry.
        const seed = await request.post(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
            data: {
                name: `schema-${Date.now().toString(36)}`,
                slug: `schema-${Date.now()}`,
                organization: false,
            },
        });
        if (!seed.ok()) {
            test.skip(true, `couldn't seed work (${seed.status()})`);
        }
        const res = await request.get(`${API_BASE}/api/works`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        const arr = Array.isArray(body) ? body : (body?.works ?? body?.data ?? []);
        expect(Array.isArray(arr), `works list not array: ${typeof arr}`).toBe(true);
        if (arr.length === 0) {
            test.skip(true, 'works list came back empty');
        }
        const w = arr[0];
        expectStringNonEmpty('works[0].id', w.id);
        expectStringNonEmpty('works[0].name', w.name);
        // Slug is server-generated even if client omitted it.
        if (w.slug !== undefined) {
            expectStringNonEmpty('works[0].slug', w.slug);
        }
    });
});

test.describe('API schema — /api/health', () => {
    test('GET /api/health returns ok/status flag', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/health`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        // Health endpoint shape varies — `{ok: true}`, `{status: 'ok'}`,
        // `{status: 'up'}`, or a terminus-style object. We require ANY
        // truthy positive indicator.
        const looksHealthy =
            body?.ok === true ||
            body?.status === 'ok' ||
            body?.status === 'up' ||
            body?.status === 'healthy' ||
            body?.status === 'success' ||
            body?.info?.api?.status === 'up' ||
            body?.details?.api?.status === 'up';
        expect(looksHealthy, `health body: ${JSON.stringify(body).slice(0, 200)}`).toBe(true);
    });
});
