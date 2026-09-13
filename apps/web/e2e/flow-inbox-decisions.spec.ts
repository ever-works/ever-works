import { test, expect, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * My Decisions — the Inbox read as a decision queue.
 *
 *   GET  /api/inbox/decisions          the questions, approvals and escalations
 *                                      waiting on me (?status ?kind ?agentId ?taskId
 *                                      ?missionId ?q ?limit ?offset) + header counts
 *   GET  /api/inbox/decisions/counts   open / blocking / latest raise
 *   POST /api/inbox/:id/reply          `requireReason` opts into the answer rule
 *   /inbox?view=decisions              the view itself
 *
 * What a fresh owner can observe end-to-end, and what this pins:
 *
 *   - a fresh owner reads an EMPTY queue with real zero counts and
 *     `lastRaisedAt: null` (the "never had one" signal the empty state
 *     keys on) — not a 400 from the `:id` route swallowing `decisions`;
 *   - the query is validated at the edge: a notice is not a decision
 *     kind, the page size is 1–100, ids are UUIDs, the tab is an Inbox
 *     status, and the search is bounded;
 *   - `requireReason` must be a boolean, and a reply to an id the caller
 *     does not own is 404 — never 403, so it cannot prove the item exists;
 *   - every route is authenticated;
 *   - the view renders under the Inbox, never as an empty queue on a
 *     failed read, and keeps its tab and filters in the URL.
 *
 * NOTE: nothing on the public API mints an Inbox decision (escalations and
 * proposals are written by the agent runtime), so populated ranking,
 * answering and the restart outcome are covered by the agent-package
 * integration spec and the web unit specs rather than here.
 */

const DECISIONS = `${API_BASE}/api/inbox/decisions`;
const BOGUS_ID = '00000000-0000-4000-8000-000000000000';
const DECISIONS_URL = '/inbox?view=decisions';

test.describe('My Decisions — API contract', () => {
    test('a fresh owner reads an empty queue with zero counts and no latest raise', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);

        const list = await request.get(DECISIONS, { headers });
        expect(list.status(), `list body=${await list.text().catch(() => '')}`).toBe(200);
        expect(await list.json()).toEqual({
            data: [],
            meta: {
                total: 0,
                limit: 25,
                offset: 0,
                openCount: 0,
                blockingCount: 0,
                lastRaisedAt: null,
            },
        });

        const counts = await request.get(`${DECISIONS}/counts`, { headers });
        expect(counts.status()).toBe(200);
        expect(await counts.json()).toEqual({ open: 0, blocking: 0, lastRaisedAt: null });

        // Every tab and filter reads empty, never an error, for a new owner.
        for (const query of [
            '?status=answered',
            '?status=archived',
            '?kind=escalation&q=budget',
            `?taskId=${BOGUS_ID}&missionId=${BOGUS_ID}&agentId=${BOGUS_ID}`,
            '?limit=100&offset=50',
        ]) {
            const res = await request.get(`${DECISIONS}${query}`, { headers });
            expect(res.status(), `query ${query}`).toBe(200);
            const body = await res.json();
            expect(body.data, `query ${query}`).toEqual([]);
            expect(body.meta.total, `query ${query}`).toBe(0);
        }
    });

    test('refuses malformed queries at the edge', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);

        for (const query of [
            '?kind=notice',
            '?kind=bogus',
            '?status=deleted',
            '?limit=0',
            '?limit=101',
            '?offset=-1',
            '?taskId=not-a-uuid',
            '?agentId=123',
            '?missionId=nope',
            `?q=${'x'.repeat(201)}`,
        ]) {
            const res = await request.get(`${DECISIONS}${query}`, { headers });
            expect(res.status(), `query ${query}`).toBe(400);
        }
    });

    test('the reason flag is validated and a foreign reply is 404, never 403', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const headers = authedHeaders(owner.access_token);

        const badFlag = await request.post(`${API_BASE}/api/inbox/${BOGUS_ID}/reply`, {
            headers,
            data: { optionId: 'reject', requireReason: 'yes' },
        });
        expect(badFlag.status()).toBe(400);

        const foreign = await request.post(`${API_BASE}/api/inbox/${BOGUS_ID}/reply`, {
            headers,
            data: { optionId: 'reject', text: 'Not now.', requireReason: true },
        });
        expect(foreign.status()).toBe(404);
    });

    test('every decision route requires authentication', async ({ request }) => {
        expect((await request.get(DECISIONS)).status()).toBe(401);
        expect((await request.get(`${DECISIONS}/counts`)).status()).toBe(401);
    });
});

/** Retry a client control until the URL reflects it (hydration can swallow the first input). */
async function untilUrl(page: Page, act: () => Promise<void>, pattern: RegExp): Promise<void> {
    await expect
        .poll(
            async () => {
                if (!pattern.test(page.url())) await act();
                return page.url();
            },
            { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .toMatch(pattern);
}

test.describe('My Decisions — the Inbox view', () => {
    test('renders under the Inbox with its tabs, and never an error for a readable queue', async ({
        page,
    }) => {
        await page.goto(DECISIONS_URL, { waitUntil: 'domcontentloaded' });
        await expect(page).not.toHaveURL(/\/login/);
        await expect(page.getByRole('heading', { name: 'My Decisions' })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId('decisions-list')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('decisions-error')).toHaveCount(0);

        // The Inbox's own views are one click away, and this one is among them.
        await expect(page.getByRole('link', { name: 'Active' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Archived' }).first()).toBeVisible();
        for (const tab of ['Open', 'Answered']) {
            await expect(page.getByRole('link', { name: tab, exact: true })).toBeVisible();
        }
    });

    test('keeps the kind filter and the tab in the URL', async ({ page }) => {
        await page.goto(DECISIONS_URL, { waitUntil: 'domcontentloaded' });
        const kind = page.getByTestId('decisions-filter-kind');
        await expect(kind).toBeVisible({ timeout: 30_000 });

        await untilUrl(
            page,
            async () => {
                // Reset first: a select changed before hydration keeps its DOM
                // value, so re-picking the same option would fire nothing.
                await kind.selectOption('');
                await kind.selectOption('approval');
            },
            /kind=approval/,
        );
        await expect(page).toHaveURL(/view=decisions/);
        await expect(page.getByTestId('decisions-clear-filters')).toBeVisible({ timeout: 30_000 });

        await page.getByRole('link', { name: 'Answered', exact: true }).click();
        await expect(page).toHaveURL(/tab=answered/, { timeout: 30_000 });
        await expect(page).toHaveURL(/kind=approval/);
    });

    test('the Inbox message view links to My Decisions', async ({ page }) => {
        await page.goto('/inbox', { waitUntil: 'domcontentloaded' });
        const tab = page.getByRole('link', { name: 'My Decisions' });
        await expect(tab).toBeVisible({ timeout: 30_000 });
        await expect(tab).toHaveAttribute('href', /\/inbox\?view=decisions$/);
    });
});
