import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Skills shelf — readiness badges, end to end.
 *
 * API half (a fresh user per test, so the shelf is exactly what the test
 * seeded): a Skill with no binding reads "not reaching any agent", a bound
 * Skill that declares nothing is ready, a Skill whose declared tool is served
 * by a connection nobody set up names that connection, and the summary counts
 * add up. UI half (the seeded user): the badge text is in the server-rendered
 * shelf and the detail page shows the Readiness + Requirements panels.
 */

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createSkill(
    request: APIRequestContext,
    token: string,
    ownerId: string,
    data: { title: string; frontmatter?: Record<string, unknown>; instructionsMd?: string },
) {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            ownerType: 'tenant',
            ownerId,
            title: data.title,
            description: 'created by the shelf e2e',
            instructionsMd: data.instructionsMd ?? `# ${data.title}`,
            frontmatter: data.frontmatter,
        },
    });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
}

async function bindTenant(request: APIRequestContext, token: string, skillId: string) {
    const res = await request.post(`${API_BASE}/api/skills/${skillId}/bindings`, {
        headers: authedHeaders(token),
        data: { targetType: 'tenant' },
    });
    expect(res.status()).toBe(201);
}

async function readiness(request: APIRequestContext, token: string, skillId: string) {
    const res = await request.post(`${API_BASE}/api/skills/${skillId}/readiness/refresh`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

test.describe('Skills shelf — readiness (API)', () => {
    test('unbound → needs_setup; bound and declaring nothing → ready', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const skill = await createSkill(request, u.access_token, u.user.id, {
            title: `Unbound ${uniq()}`,
        });

        const before = await readiness(request, u.access_token, skill.id);
        expect(before).toMatchObject({ readiness: 'needs_setup', cardState: 'needs_setup' });
        expect(before.readinessDetail.boundTargetCount).toBe(0);

        await bindTenant(request, u.access_token, skill.id);
        const after = await readiness(request, u.access_token, skill.id);
        expect(after).toMatchObject({ readiness: 'ready', cardState: 'ready' });
    });

    test('a tool served by a missing connection is named, never summarised', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const server = `shelf-${uniq()}`;
        const skill = await createSkill(request, u.access_token, u.user.id, {
            title: `Needs connection ${uniq()}`,
            frontmatter: { allowedTools: [`mcp__${server}__create_invoice`] },
        });
        await bindTenant(request, u.access_token, skill.id);

        const verdict = await readiness(request, u.access_token, skill.id);
        expect(verdict.cardState).toBe('missing_requirements');
        expect(verdict.readinessDetail.requirements).toContainEqual(
            expect.objectContaining({
                kind: 'connection',
                id: server,
                status: 'missing',
                reason: 'notConnected',
            }),
        );
        // Identifiers only — no value-shaped field anywhere in the detail.
        expect(JSON.stringify(verdict.readinessDetail)).not.toMatch(/"value"/);
    });

    test('the list carries card state, tags, reach and per-state counts', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const ready = await createSkill(request, u.access_token, u.user.id, {
            title: `Ready ${uniq()}`,
        });
        await bindTenant(request, u.access_token, ready.id);
        await createSkill(request, u.access_token, u.user.id, { title: `Unbound ${uniq()}` });

        const list = await (
            await request.get(`${API_BASE}/api/skills`, { headers: authedHeaders(u.access_token) })
        ).json();
        // The pre-shelf meta shape is untouched; counts ride beside it.
        expect(list.meta).toEqual({ total: 2, limit: 50, offset: 0 });
        expect(list.counts.ready + list.counts.needs_setup).toBe(2);
        const row = list.data.find((s: { id: string }) => s.id === ready.id);
        expect(row).toMatchObject({
            cardState: 'ready',
            provenance: 'authored',
            boundTargetCount: 1,
        });
        expect(Array.isArray(row.tags)).toBe(true);

        const attention = await (
            await request.get(`${API_BASE}/api/skills?readiness=attention`, {
                headers: authedHeaders(u.access_token),
            })
        ).json();
        expect(attention.data.map((s: { id: string }) => s.id)).not.toContain(ready.id);
        expect(attention.data).toHaveLength(1);
    });

    test('another user’s Skill answers 404 on the readiness endpoints', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const skill = await createSkill(request, owner.access_token, owner.user.id, {
            title: `Private ${uniq()}`,
        });
        for (const [method, path] of [
            ['get', `/api/skills/${skill.id}/readiness`],
            ['post', `/api/skills/${skill.id}/readiness/refresh`],
        ] as const) {
            const res = await request[method](`${API_BASE}${path}`, {
                headers: authedHeaders(other.access_token),
            });
            expect(res.status(), `${method} ${path}`).toBe(404);
        }
    });
});

test.describe('Skills shelf — readiness (UI, seeded user)', () => {
    test('an unbound Skill’s badge is in the shelf and the detail page explains it', async ({
        page,
        request,
    }) => {
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        const { access_token, user } = await login.json();
        const title = `Shelf badge ${uniq()}`;
        const skill = await createSkill(request, access_token, user.id, { title });

        await page.goto(`/agents?search=${encodeURIComponent(title)}#skills`, {
            waitUntil: 'domcontentloaded',
        });
        const card = page.locator(`[data-testid="skill-shelf-card"][data-skill-id="${skill.id}"]`);
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card).toHaveAttribute('data-state', 'needs_setup');
        await expect(card.getByTestId('skill-readiness-badge')).toContainText(
            'Not reaching any agent',
        );
        await expect(page.getByTestId('skill-shelf-summary')).toBeVisible();

        await page.goto(`/skills/${skill.id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('skill-readiness-panel')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('skill-requirements-panel')).toBeVisible();
        await expect(page.getByTestId('skill-provenance-panel')).toContainText(
            'Written in this workspace.',
        );
    });
});
