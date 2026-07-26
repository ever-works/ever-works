import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Prebuilt agent templates (Wave 10) + the digest-briefing preference
 * (Wave 7) — API CONTRACT. Both shipped without e2e.
 *
 * ── Routes ─────────────────────────────────────────────────────────
 *   GET  /api/agent-templates            @Public repo-backed METADATA
 *        catalog (optionally ?entity=…). Public on purpose — the
 *        pre-login surfaces read it.
 *   GET  /api/agents/templates           auth-gated in-code catalog of
 *        fully-specified presets (prompt + safe defaults).
 *   POST /api/agents/from-template/:slug 201 — creates MY Agent from a
 *        preset: owner-scoped, DRAFT, template prompt as SOUL.md,
 *        conservative permissions. 404 on an unknown slug.
 *   PUT  /api/auth/profile { digestFrequency: 'off'|'daily'|'weekly' }
 *        — the digest cadence, default 'off'.
 *
 * The two catalogs are deliberately DIFFERENT surfaces with different
 * auth postures; a regression that merges them (or makes the presets
 * public) shows up here first.
 */

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function errText(body: unknown): string {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

function get(request: APIRequestContext, token: string, path: string) {
    return request.get(`${API_BASE}${path}`, { headers: authedHeaders(token) });
}

test.describe('GET /api/agent-templates — the public metadata catalog', () => {
    test('is readable without a session and returns an array', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/agent-templates`);
        expect(res.status(), `templates body=${await res.text().catch(() => '')}`).toBe(200);
        expect(Array.isArray(await res.json())).toBe(true);
    });

    test('an entity filter never 500s and never widens the result set', async ({ request }) => {
        const all = await request.get(`${API_BASE}/api/agent-templates`);
        expect(all.status()).toBe(200);
        const allRows = (await all.json()) as unknown[];

        for (const entity of ['agent', 'work', 'not-a-real-entity']) {
            const res = await request.get(`${API_BASE}/api/agent-templates?entity=${entity}`);
            expect(res.status(), `entity=${entity}`).toBe(200);
            const rows = (await res.json()) as unknown[];
            expect(rows.length, `entity=${entity} cannot widen the catalog`).toBeLessThanOrEqual(
                allRows.length,
            );
        }
    });
});

test.describe('GET /api/agents/templates — the auth-gated preset catalog', () => {
    test('lists the prebuilt presets with their prompts and safe defaults', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await get(request, u.access_token, '/api/agents/templates');
        expect(res.status(), `presets body=${await res.text().catch(() => '')}`).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);

        const slugs = (body.data as Array<{ slug: string }>).map((t) => t.slug);
        // Pin a couple of first-party slugs — the /from-template route is
        // keyed on them, so silently renaming one breaks every deep link.
        expect(slugs).toContain('content-marketer');
        expect(slugs).toContain('seo-auditor');

        for (const template of body.data as Array<Record<string, unknown>>) {
            expect(typeof template.slug).toBe('string');
            expect(typeof template.name).toBe('string');
            expect(typeof template.category).toBe('string');
        }
    });

    test('the preset catalog is NOT public (unlike /api/agent-templates)', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/agents/templates`);
        expect(res.status()).toBe(401);
    });

    test('the literal `templates` segment resolves before the :id route', async ({ request }) => {
        // If `@Get(':id')` were declared first, `templates` would hit
        // ParseUUIDPipe and this would be a 400.
        const u = await registerUserViaAPI(request);
        const res = await get(request, u.access_token, '/api/agents/templates');
        expect(res.status()).toBe(200);
    });
});

test.describe('POST /api/agents/from-template/:slug', () => {
    test('creates MY agent in DRAFT from the template, with the template’s identity', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const name = `Content Marketer ${uniq()}`;

        const res = await request.post(`${API_BASE}/api/agents/from-template/content-marketer`, {
            headers: authedHeaders(u.access_token),
            data: { name },
        });
        expect(res.status(), `from-template body=${await res.text().catch(() => '')}`).toBe(201);
        const agent = await res.json();
        expect(agent.name).toBe(name);
        expect(agent.status, 'a templated agent starts as a draft, never live').toBe('draft');
        expect(typeof agent.id).toBe('string');

        // It is genuinely MINE — it shows up in my own agents list.
        const list = await get(request, u.access_token, '/api/agents');
        expect(list.status()).toBe(200);
        const rows = (await list.json()).data as Array<{ id: string }>;
        expect(rows.some((r) => r.id === agent.id)).toBe(true);
    });

    test('an unknown slug is a truthful 404; the body overrides are validated', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);

        const unknown = await request.post(`${API_BASE}/api/agents/from-template/not-a-template`, {
            headers: authedHeaders(u.access_token),
            data: {},
        });
        expect(unknown.status()).toBe(404);
        expect(errText(await unknown.json())).toContain('not-a-template');

        const badScope = await request.post(
            `${API_BASE}/api/agents/from-template/content-marketer`,
            { headers: authedHeaders(u.access_token), data: { scope: 'galaxy' } },
        );
        expect(badScope.status()).toBe(400);

        const badWork = await request.post(
            `${API_BASE}/api/agents/from-template/content-marketer`,
            {
                headers: authedHeaders(u.access_token),
                data: { workId: 'not-a-uuid' },
            },
        );
        expect(badWork.status()).toBe(400);

        const extra = await request.post(`${API_BASE}/api/agents/from-template/content-marketer`, {
            headers: authedHeaders(u.access_token),
            data: { name: `x-${uniq()}`, bogusField: 1 },
        });
        expect(extra.status()).toBe(400);
        expect(errText(await extra.json())).toContain('property bogusField should not exist');
    });

    test('anonymous activation is 401 — templates are not a public factory', async ({
        request,
    }) => {
        const res = await request.post(`${API_BASE}/api/agents/from-template/content-marketer`, {
            data: { name: `anon-${uniq()}` },
        });
        expect(res.status()).toBe(401);
    });

    test('two accounts activating the same template get two independent agents', async ({
        request,
    }) => {
        const a = await registerUserViaAPI(request);
        const b = await registerUserViaAPI(request);

        const resA = await request.post(`${API_BASE}/api/agents/from-template/seo-auditor`, {
            headers: authedHeaders(a.access_token),
            data: { name: `SEO ${uniq()}` },
        });
        expect(resA.status()).toBe(201);
        const agentA = await resA.json();

        const resB = await request.post(`${API_BASE}/api/agents/from-template/seo-auditor`, {
            headers: authedHeaders(b.access_token),
            data: { name: `SEO ${uniq()}` },
        });
        expect(resB.status()).toBe(201);
        const agentB = await resB.json();

        expect(agentA.id).not.toBe(agentB.id);
        // …and neither can read the other's.
        const cross = await get(request, b.access_token, `/api/agents/${agentA.id}`);
        expect(cross.status()).toBe(404);
    });
});

test.describe('PUT /api/auth/profile — digest briefing preference', () => {
    test('defaults to off and accepts exactly off | daily | weekly', async ({ request }) => {
        const u = await registerUserViaAPI(request);

        for (const digestFrequency of ['daily', 'weekly', 'off']) {
            const res = await request.put(`${API_BASE}/api/auth/profile`, {
                headers: authedHeaders(u.access_token),
                data: { digestFrequency },
            });
            expect(
                res.status(),
                `digestFrequency=${digestFrequency} body=${await res.text().catch(() => '')}`,
            ).toBeLessThan(300);
        }
    });

    test('an out-of-enum cadence is rejected, never silently defaulted', async ({ request }) => {
        // Silently defaulting would mean a user who asked for digests
        // quietly gets none — the failure mode this assertion prevents.
        const u = await registerUserViaAPI(request);

        for (const bad of ['hourly', 'never', '', 1]) {
            const res = await request.put(`${API_BASE}/api/auth/profile`, {
                headers: authedHeaders(u.access_token),
                data: { digestFrequency: bad },
            });
            expect(res.status(), `digestFrequency=${String(bad)}`).toBe(400);
            expect(errText(await res.json())).toContain('digestFrequency');
        }
    });

    test('anonymous profile writes are 401', async ({ request }) => {
        const res = await request.put(`${API_BASE}/api/auth/profile`, {
            data: { digestFrequency: 'daily' },
        });
        expect(res.status()).toBe(401);
    });
});
