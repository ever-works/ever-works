import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, orgScopedHeaders } from './helpers/api';
import { createOrganizationViaAPI } from './helpers/organizations';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Home (AW-19) — the morning read on the dashboard root.
 *
 * The API half pins the summary contract: one response carrying every block
 * with its own status, never cacheable, narrowable to one block, and with no
 * parameter that can name another user or Organization. The UI half pins the
 * order of the morning stack and that everything Home showed before still
 * renders under `Your workspace`.
 *
 * Block contents depend on what the shared e2e account happens to hold, so the
 * UI assertions check structure and state, not counts; the counts and
 * thresholds are pinned by the agent and web unit specs.
 */

const BLOCKS = ['needsYou', 'glance', 'today', 'thisWeek', 'workingNow', 'recentActivity'] as const;

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

test.describe('Home summary — API contract', () => {
    test('returns every block with a status, the day it covers, and is never cacheable', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const res = await request.get(`${API_BASE}/api/home/summary?tz=Europe%2FKyiv`, {
            headers: authedHeaders(token),
        });

        expect(res.status()).toBe(200);
        expect(res.headers()['cache-control']).toContain('no-store');
        const body = await res.json();
        expect(body.timezone).toBe('Europe/Kyiv');
        expect(body.timezoneFallback).toBe(false);
        expect(typeof body.computedAt).toBe('string');
        expect(body.day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        for (const id of BLOCKS) {
            expect(body[id], `block ${id}`).toBeDefined();
            expect(['ok', 'failed']).toContain(body[id].status);
            // A failed block carries a message key and never pretends to be empty.
            if (body[id].status === 'failed') {
                expect(body[id].data).toBeNull();
                expect(['timeout', 'unavailable', 'error']).toContain(body[id].errorKey);
            }
        }
    });

    test('narrows to the asked-for block for a per-block retry', async ({ request }) => {
        const token = await seededToken(request);
        const res = await request.get(`${API_BASE}/api/home/summary?blocks=today`, {
            headers: authedHeaders(token),
        });

        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.today).toBeDefined();
        for (const id of BLOCKS.filter((block) => block !== 'today')) {
            expect(body[id], `block ${id}`).toBeUndefined();
        }
    });

    test('refuses an unknown timezone or block, and any subject parameter', async ({ request }) => {
        const token = await seededToken(request);
        for (const query of [
            'tz=Mars%2FOlympus_Mons',
            'blocks=tomorrow',
            'userId=someone',
            'organizationId=elsewhere',
        ]) {
            const res = await request.get(`${API_BASE}/api/home/summary?${query}`, {
                headers: authedHeaders(token),
            });
            expect(res.status(), query).toBe(400);
        }
    });

    test('requires a session', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/home/summary`);
        expect(res.status()).toBe(401);
    });

    test('follows the Organization scope: a new Organization starts with nothing waiting (S19)', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const org = await createOrganizationViaAPI(request, token, `Home Org ${stamp()}`);

        const res = await request.get(`${API_BASE}/api/home/summary`, {
            headers: orgScopedHeaders(token, org.slug),
        });

        expect(res.status()).toBe(200);
        const body = await res.json();
        if (body.workingNow.status === 'ok') {
            expect(body.workingNow.data.total).toBe(0);
        }
        if (body.recentActivity.status === 'ok') {
            expect(body.recentActivity.data.entries).toEqual([]);
        }
        if (body.thisWeek.status === 'ok') {
            expect(body.thisWeek.data.scope.kind).toBe('organization');
            expect(body.thisWeek.data.totalCents).toBe(0);
            expect(body.thisWeek.data.runsCount).toBe(0);
        }
    });
});

test.describe('Home — the morning stack', () => {
    test('renders the composer and the blocks in the owner’s order above More (S1, owner 2026-09-18)', async ({
        page,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });

        const morning = page.getByTestId('home-morning');
        await expect(morning).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('home-composer')).toBeVisible();

        // Owner 2026-09-18 — the page header is gone: no greeting, no
        // subtitle, no date line, no "Times shown in UTC." footnote. The
        // timezone is a setting now (`Settings → Profile → Time zone`).
        await expect(page.getByTestId('home-greeting')).toHaveCount(0);
        await expect(page.getByTestId('home-score-line')).toHaveCount(0);
        await expect(page.getByTestId('home-timezone-footnote')).toHaveCount(0);
        await expect(page.getByText('Manage your AI-powered works')).toHaveCount(0);

        const firstRun = page.getByTestId('home-first-run');
        const summaryError = page.getByTestId('home-summary-error');
        if ((await firstRun.count()) === 0 && (await summaryError.count()) === 0) {
            // `Your workspace` (the merged Today + All card) leads, then Needs
            // you, Working now, Today beside This week, and Recent activity
            // last — exactly the order the owner asked for.
            const ORDER = [
                'workspace',
                'needsYou',
                'workingNow',
                'today',
                'thisWeek',
                'recentActivity',
            ] as const;
            const positions: number[] = [];
            for (const id of ORDER) {
                const block = page.getByTestId(`home-block-${id}`);
                // This week renders nothing for an account that never spent.
                if (id === 'thisWeek' && (await block.count()) === 0) continue;
                await expect(block, `block ${id}`).toBeVisible();
                positions.push((await block.boundingBox())?.y ?? -1);
            }
            // Today and This week share a row on wide screens; every other block follows in order.
            const sorted = [...positions].sort((a, b) => a - b);
            expect(positions[0]).toBe(sorted[0]);
            expect(positions[positions.length - 1]).toBe(sorted[sorted.length - 1]);

            // Recent activity is the last block on the page — the owner's item 1.
            const recent = page.getByTestId('home-block-recentActivity');
            const lastPosition = positions[positions.length - 1];
            expect((await recent.boundingBox())?.y).toBe(lastPosition);

            // The merged stats card really does hold both halves.
            const workspace = page.getByTestId('home-block-workspace');
            await expect(workspace.getByRole('heading', { name: 'Your workspace' })).toBeVisible();
            await expect(workspace.getByRole('heading', { name: 'Today' })).toBeVisible();
            await expect(workspace.getByRole('heading', { name: 'All' })).toBeVisible();
        }

        const workspace = page.getByTestId('home-workspace');
        await expect(workspace).toBeVisible();
        await expect(workspace.getByRole('button', { name: /More/ })).toHaveAttribute(
            'aria-expanded',
            'true',
        );
        expect(
            await morning.evaluate(
                (element, other) => {
                    return Boolean(
                        element.compareDocumentPosition(other as Node) &
                        Node.DOCUMENT_POSITION_FOLLOWING,
                    );
                },
                await workspace.elementHandle(),
            ),
        ).toBe(true);
    });

    test('More collapses and expands without losing what it holds', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        const toggle = page.getByTestId('home-workspace').getByRole('button', { name: /More/ });
        await expect(toggle).toBeVisible({ timeout: 30_000 });

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });

    test('links each block to the surface that owns its data', async ({ page }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('home-morning')).toBeVisible({ timeout: 30_000 });

        const feedLink = page
            .getByTestId('home-block-recentActivity')
            .getByRole('link', { name: /Open the feed/ });
        if ((await feedLink.count()) > 0) {
            await expect(feedLink).toHaveAttribute('href', /\/activity\?view=feed$/);
        }
        const failedToday = page.getByTestId('home-glance-failedToday');
        if ((await failedToday.count()) > 0) {
            // The runs counter links straight at the Activity page's Runs view —
            // the ledger is not a page of its own any more.
            await expect(failedToday).toHaveAttribute(
                'href',
                /\/activity\?view=runs&g=day&status=failed$/,
            );
        }
    });
});
