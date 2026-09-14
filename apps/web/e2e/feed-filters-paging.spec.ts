import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, orgScopedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI, createTaskViaAPI } from './helpers/agents-tasks';
import { createOrganizationViaAPI } from './helpers/organizations';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { clickAndExpectUrl, clickUntil } from './helpers/nav';

/**
 * Live Feed — filters and paging (spec S4, S5, S8, S12, S15), plus the API
 * contract behind them.
 *
 * The Live Feed is a view of the Activity page (`/activity?view=feed`), next
 * to Log and Schedules; it reads the same activity records the Log lists.
 *
 * Deterministic by construction: every UI assertion is scoped to rows this
 * spec wrote itself (a fresh agent, or a filter that matches nothing), never
 * to however much activity the shared seeded user has accumulated.
 */

const ACTIVITY_URL = '/en/activity';

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

/** A fresh agent with one feed entry of its own (draft → active writes `agent_resumed`). */
async function agentWithOneEntry(request: APIRequestContext, token: string, name: string) {
    const agent = await createAgentViaAPI(request, token, { name });
    const resumed = await request.post(`${API_BASE}/api/agents/${agent.id}/resume`, {
        headers: authedHeaders(token),
    });
    expect(resumed.status(), `resume body=${await resumed.text().catch(() => '')}`).toBe(200);
    // The activity write is best-effort after the response; wait for it.
    await expect
        .poll(
            async () => {
                const res = await request.get(`${API_BASE}/api/feed?agentIds=${agent.id}`, {
                    headers: authedHeaders(token),
                });
                return res.ok() ? ((await res.json()).items as unknown[]).length : -1;
            },
            { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
    return agent;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test.describe('Live Feed — API contract', () => {
    test('GET /api/feed without a session is 401', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/feed`);
        expect(res.status()).toBe(401);
    });

    test('returns a page of narrated entries, never a raw action token', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        await createTaskViaAPI(request, user.access_token, { title: `Feed shape ${stamp()}` });

        const res = await request.get(`${API_BASE}/api/feed`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body.items)).toBe(true);
        expect(typeof body.hasMore).toBe('boolean');
        expect(typeof body.historyFloor).toBe('string');
        expect(body.items.length).toBeGreaterThan(0);
        for (const item of body.items) {
            expect(['work', 'decision', 'delivery', 'problem', 'system']).toContain(item.kind);
            expect(['agent', 'user', 'external', 'system']).toContain(item.actor.kind);
            expect(typeof item.narration.key).toBe('string');
            if (item.narration.key === 'fallback') {
                expect(String(item.narration.params.action)).not.toContain('_');
            }
        }
        const created = body.items.find(
            (item: { actionType: string }) => item.actionType === 'task_created',
        );
        expect(created?.narration).toMatchObject({
            key: 'taskCreated',
            params: { hasSubject: 'yes' },
        });
        expect(created?.actor.kind).toBe('user');
        expect(created?.target?.type).toBe('task');
    });

    test('pages backwards by cursor with no repeated and no skipped entry', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        for (let i = 0; i < 7; i++) {
            await createTaskViaAPI(request, user.access_token, { title: `Paging ${i} ${stamp()}` });
        }

        const all = await request.get(`${API_BASE}/api/feed?limit=50`, {
            headers: authedHeaders(user.access_token),
        });
        const expectedIds = ((await all.json()).items as Array<{ id: string }>).map(
            (item) => item.id,
        );
        expect(expectedIds.length).toBeGreaterThanOrEqual(7);

        const seen: string[] = [];
        const times: string[] = [];
        let cursor: string | null = null;
        for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
            const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
            const res = await request.get(`${API_BASE}/api/feed?limit=3${query}`, {
                headers: authedHeaders(user.access_token),
            });
            expect(res.status()).toBe(200);
            const body = await res.json();
            expect(body.items.length).toBeLessThanOrEqual(3);
            for (const item of body.items) {
                seen.push(item.id);
                times.push(item.createdAt);
            }
            if (pageIndex === 0) {
                // Activity landing at the head between reads must not shift the pages.
                await createTaskViaAPI(request, user.access_token, {
                    title: `Head insert ${stamp()}`,
                });
            }
            cursor = body.nextCursor;
            if (!cursor) break;
        }

        // No repeats, no skips (every entry that existed before paging began
        // was reached), and newest first throughout.
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toEqual(expect.arrayContaining(expectedIds));
        expect([...times].sort().reverse()).toEqual(times);
    });

    test('refuses an unreadable cursor with a clear error', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/feed?cursor=not-a-real-cursor`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'invalid-cursor' });
    });

    test('refuses a 21st agent instead of silently truncating', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const ids = Array.from({ length: 21 }, (_, i) => uuid(i + 1)).join(',');
        const res = await request.get(`${API_BASE}/api/feed?agentIds=${ids}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'too-many-agents', max: 20 });

        const twenty = Array.from({ length: 20 }, (_, i) => uuid(i + 1)).join(',');
        const ok = await request.get(`${API_BASE}/api/feed?agentIds=${twenty}`, {
            headers: authedHeaders(user.access_token),
        });
        expect(ok.status()).toBe(200);
    });

    test('never returns more than 50 entries in a page', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/feed?limit=500`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).items.length).toBeLessThanOrEqual(50);
    });

    test('kind and only-failed filters return only matching entries', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        await createTaskViaAPI(request, user.access_token, { title: `Kinds ${stamp()}` });

        const work = await request.get(`${API_BASE}/api/feed?kinds=work`, {
            headers: authedHeaders(user.access_token),
        });
        const workItems = (await work.json()).items as Array<{ kind: string }>;
        expect(workItems.length).toBeGreaterThan(0);
        expect(new Set(workItems.map((item) => item.kind))).toEqual(new Set(['work']));

        const failed = await request.get(`${API_BASE}/api/feed?failedOnly=true&kinds=work`, {
            headers: authedHeaders(user.access_token),
        });
        expect(failed.status()).toBe(200);
        for (const item of (await failed.json()).items as Array<{ kind: string }>) {
            expect(item.kind).toBe('problem');
        }
    });

    test('filters by agent, names the agent, and never shows another user the entries', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const name = `Feed Agent ${stamp()}`;
        const agent = await agentWithOneEntry(request, owner.access_token, name);

        const res = await request.get(`${API_BASE}/api/feed?agentIds=${agent.id}`, {
            headers: authedHeaders(owner.access_token),
        });
        const items = (await res.json()).items;
        expect(items.length).toBeGreaterThan(0);
        expect(items[0].actor).toMatchObject({ kind: 'agent', agentId: agent.id, label: name });
        expect(items[0].target).toEqual({ type: 'agent', id: agent.id });

        const roster = await request.get(`${API_BASE}/api/feed/actors`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(roster.status()).toBe(200);
        const listed = (
            (await roster.json()).actors as Array<{ agentId: string; count: number }>
        ).find((actor) => actor.agentId === agent.id);
        expect(listed?.count).toBeGreaterThan(0);

        // Another user asking for the same agent gets the same answer as for an agent that does not exist.
        const stranger = await registerUserViaAPI(request);
        const foreign = await request.get(`${API_BASE}/api/feed?agentIds=${agent.id}`, {
            headers: authedHeaders(stranger.access_token),
        });
        const missing = await request.get(`${API_BASE}/api/feed?agentIds=${uuid(999)}`, {
            headers: authedHeaders(stranger.access_token),
        });
        expect(foreign.status()).toBe(missing.status());
        expect((await foreign.json()).items).toEqual((await missing.json()).items);
    });

    test('reads only the active scope: an Organization entry stays out of the personal feed', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const org = await createOrganizationViaAPI(
            request,
            user.access_token,
            `Feed Org ${stamp()}`,
        );
        const title = `Org scoped ${stamp()}`;
        const task = await createTaskViaAPI(request, user.access_token, { title }, org.slug);

        const inOrg = await request.get(`${API_BASE}/api/feed?limit=50`, {
            headers: orgScopedHeaders(user.access_token, org.slug),
        });
        expect(inOrg.status()).toBe(200);
        const orgTargets = (
            (await inOrg.json()).items as Array<{ target: { id: string } | null }>
        ).map((item) => item.target?.id);
        expect(orgTargets).toContain(task.id);

        const personal = await request.get(`${API_BASE}/api/feed?limit=50`, {
            headers: authedHeaders(user.access_token),
        });
        const personalTargets = (
            (await personal.json()).items as Array<{ target: { id: string } | null }>
        ).map((item) => item.target?.id);
        expect(personalTargets).not.toContain(task.id);
    });
});

test.describe('Live Feed — UI', () => {
    test('the Activity page offers a Live Feed view beside Log and Schedules, deep-linkable', async ({
        page,
    }) => {
        await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
        const toggle = page.getByTestId('activity-view-toggle').first();
        await expect(toggle).toBeVisible({ timeout: 30_000 });
        await expect(toggle.getByRole('button', { name: 'Log' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(toggle.getByRole('button', { name: 'Schedules' })).toBeVisible();

        await clickAndExpectUrl(
            page,
            toggle.getByRole('button', { name: 'Live Feed' }),
            /[?&]view=feed/,
        );
        await expect(page.getByTestId('live-feed')).toBeVisible({ timeout: 30_000 });
        await expect(toggle.getByRole('button', { name: 'Live Feed' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByRole('heading', { name: 'Live Feed' })).toBeVisible();

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('live-feed')).toBeVisible({ timeout: 30_000 });
    });

    test('watching one agent shows only its entries, survives a reload, and ends at the history card', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const agent = await agentWithOneEntry(request, token, `UI Feed Agent ${stamp()}`);

        await page.goto(`${ACTIVITY_URL}?view=feed&agents=${agent.id}`, {
            waitUntil: 'domcontentloaded',
        });
        const list = page.getByTestId('feed-list');
        await expect(list).toBeVisible({ timeout: 30_000 });
        const rows = list.getByTestId('feed-entry');
        await expect(rows.first()).toContainText(agent.name);
        await expect(rows.first()).toContainText('was resumed');
        await expect(page.getByTestId('feed-end')).toContainText("That's the last 90 days");

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`agents=${agent.id}`));
        await expect(page.getByTestId('feed-list').getByTestId('feed-entry').first()).toContainText(
            agent.name,
        );
    });

    test('a filter that matches nothing shows the filtered-empty state with Clear filters', async ({
        page,
    }) => {
        await page.goto(`${ACTIVITY_URL}?view=feed&agents=${uuid(424242)}`, {
            waitUntil: 'domcontentloaded',
        });
        const empty = page.getByTestId('feed-empty-filtered');
        await expect(empty).toBeVisible({ timeout: 30_000 });
        await expect(empty).toContainText('No activity from the agents you picked');
        await expect(empty.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    });

    test('a kind chip and Only failed are reflected in the URL and restored on reload', async ({
        page,
    }) => {
        await page.goto(`${ACTIVITY_URL}?view=feed`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('live-feed')).toBeVisible({ timeout: 30_000 });

        const problemChip = page.locator('[data-testid="feed-kind-chip"][data-kind="problem"]');
        await clickUntil(
            problemChip,
            async () => (await problemChip.getAttribute('aria-pressed')) === 'true',
        );
        await expect(page).toHaveURL(/[?&]kinds=problem/);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(
            page.locator('[data-testid="feed-kind-chip"][data-kind="problem"]'),
        ).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });

        const onlyFailed = page.getByTestId('feed-only-failed');
        await clickUntil(onlyFailed, async () => onlyFailed.isChecked());
        await expect(page).toHaveURL(/[?&]failed=1/);
    });
});
