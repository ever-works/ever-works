import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, orgScopedHeaders } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Live Feed — the never-anything empty state (spec S11) and the error
 * contract (spec S13).
 *
 * S11 needs a scope where nothing has ever happened. A brand-new user is not
 * one — signing up and logging in are themselves activity — so the spec opens
 * the feed inside a brand-new Organization, whose scope has no records yet.
 *
 * S13's rendered state (Try again + Open the Activity log, no partial list)
 * cannot be forced against a healthy stack from a browser, so it is pinned by
 * `src/components/feed/LiveFeed.unit.spec.tsx`; this file pins the API side
 * of the same contract: a request the feed cannot serve is refused with a
 * stable error code, never answered with a partial page.
 */

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

test.describe('Live Feed — nothing has happened yet', () => {
    test('a scope with no activity shows the empty state with both calls to action', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const org = await createOrganizationViaAPI(request, token, `Quiet Org ${stamp()}`);

        // The API agrees the scope is empty before the UI is asked to say so.
        const res = await request.get(`${API_BASE}/api/feed`, {
            headers: orgScopedHeaders(token, org.slug),
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).items).toEqual([]);

        await page.goto(`/org/${org.slug}/activity?view=feed`, { waitUntil: 'domcontentloaded' });
        const empty = page.getByTestId('feed-empty');
        await expect(empty).toBeVisible({ timeout: 30_000 });
        await expect(empty).toContainText('Nothing has happened yet');
        await expect(empty.getByRole('link', { name: 'Create an agent' })).toBeVisible();
        await expect(empty.getByRole('link', { name: 'Start a mission' })).toBeVisible();
        await expect(page.getByTestId('feed-list')).toHaveCount(0);
    });
});

test.describe('Live Feed — errors are explicit, never partial', () => {
    test('an unreadable cursor is a 400 with a stable code and no items', async ({ request }) => {
        const token = await seededToken(request);
        for (const cursor of ['%%%', 'e30', 'x'.repeat(300)]) {
            const res = await request.get(
                `${API_BASE}/api/feed?cursor=${encodeURIComponent(cursor)}`,
                {
                    headers: authedHeaders(token),
                },
            );
            expect(res.status(), `cursor ${cursor.slice(0, 12)}`).toBe(400);
            const body = await res.json();
            expect(body.items).toBeUndefined();
        }
    });

    test('malformed filters are refused, not ignored', async ({ request }) => {
        const token = await seededToken(request);
        for (const query of [
            'agentIds=not-a-uuid',
            'kinds=everything',
            'failedOnly=maybe',
            'limit=0',
        ]) {
            const res = await request.get(`${API_BASE}/api/feed?${query}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), query).toBe(400);
        }
    });

    test('the feed exposes no way to name another user', async ({ request }) => {
        const token = await seededToken(request);
        const res = await request.get(
            `${API_BASE}/api/feed?userId=00000000-0000-4000-8000-000000000001`,
            {
                headers: authedHeaders(token),
            },
        );
        expect(res.status()).toBe(400);
    });
});
