import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * AW-21 — the capability catalogue, end to end against the real stack.
 *
 * API: `GET /api/catalog/playbooks*` serves the built-in playbooks from the
 * `playbook-provider` plugin with the caller's readiness, clamps paging, and
 * refuses malformed input. UI: `/catalog` renders the five sections in
 * order, search narrows every section at once, a no-match search offers
 * Clear, and a playbook card opens its detail page with every block.
 */

const BUILT_IN_SLUGS = [
    'weekly-operations-report',
    'daily-decision-brief',
    'directory-freshness-sweep',
    'knowledge-gap-harvest',
    'release-checklist',
    'content-refresh-queue',
    'market-watch-brief',
    'inbox-triage-drafts',
];

interface Summary {
    slug: string;
    readiness: string;
    requiredCapabilities: string[];
}

async function listPlaybooks(request: APIRequestContext, token: string, query = '') {
    const res = await request.get(`${API_BASE}/api/catalog/playbooks${query}`, {
        headers: authedHeaders(token),
    });
    return {
        status: res.status(),
        body: res.ok() ? ((await res.json()) as { items: Summary[]; total: number }) : null,
    };
}

test.describe('Capability catalogue — API', () => {
    test('serves every built-in playbook with readiness, and most need no connection', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const { status, body } = await listPlaybooks(request, user.access_token, '?limit=50');
        expect(status).toBe(200);
        const slugs = body!.items.map((item) => item.slug);
        expect(slugs).toEqual(expect.arrayContaining(BUILT_IN_SLUGS));
        expect(body!.total).toBeGreaterThanOrEqual(BUILT_IN_SLUGS.length);

        const standalone = body!.items.filter(
            (item) => BUILT_IN_SLUGS.includes(item.slug) && item.requiredCapabilities.length === 0,
        );
        expect(standalone.length).toBeGreaterThanOrEqual(5);
        for (const item of standalone) {
            expect(item.readiness, item.slug).toBe('ready');
        }
    });

    test('filters, ranks, clamps and validates', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const research = await listPlaybooks(request, token, '?category=research');
        const builtInResearch = research
            .body!.items.map((item) => item.slug)
            .filter((slug) => BUILT_IN_SLUGS.includes(slug));
        expect(builtInResearch).toEqual(['market-watch-brief']);

        const weekly = await listPlaybooks(request, token, '?search=weekly%20operations');
        expect(weekly.body!.items[0]?.slug).toBe('weekly-operations-report');

        const clamped = await listPlaybooks(request, token, '?limit=500');
        expect(clamped.status).toBe(200);
        expect(clamped.body!.items.length).toBeLessThanOrEqual(50);

        expect((await listPlaybooks(request, token, '?search=a')).status).toBe(400);
        expect((await listPlaybooks(request, token, '?category=sales')).status).toBe(400);

        const unknown = await request.get(`${API_BASE}/api/catalog/playbooks/no-such-playbook`, {
            headers: authedHeaders(token),
        });
        expect(unknown.status()).toBe(404);
        const malformed = await request.get(`${API_BASE}/api/catalog/playbooks/Not_A_Slug`, {
            headers: authedHeaders(token),
        });
        expect(malformed.status()).toBe(400);
    });

    test('requires a session', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/catalog/playbooks`);
        expect(res.status()).toBe(401);
    });

    test('a playbook detail declares every block the page renders', async ({ request }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/catalog/playbooks/market-watch-brief`, {
            headers: authedHeaders(user.access_token),
        });
        expect(res.status()).toBe(200);
        const { entry, readiness } = await res.json();
        expect(entry.trigger.description).toBeTruthy();
        expect(entry.steps.length).toBeGreaterThanOrEqual(2);
        expect(entry.artefacts.length).toBeGreaterThan(0);
        expect(entry.escalations.length).toBeGreaterThan(0);
        expect(entry.provision.guardrailsAtAdoption.mode).toBe('require_approval');
        expect(['ready', 'needs_connection', 'blocked', 'adopted']).toContain(readiness.state);
        expect(readiness.connections.map((c: { capability: string }) => c.capability)).toEqual(
            expect.arrayContaining(['search', 'content-extractor']),
        );
    });
});

test.describe('Capability catalogue — page', () => {
    test('renders five sections, searches across them, and opens a playbook', async ({ page }) => {
        await page.goto('/en/catalog', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1, name: 'What you can do' })).toBeVisible({
            timeout: 30_000,
        });

        const sections = page.locator('[data-testid^="catalog-section-"] h2');
        await expect(sections).toHaveText([
            'Playbooks',
            'Skills',
            'Workflows',
            'Task templates',
            'Starting points',
        ]);

        const playbooks = page.getByTestId('catalog-section-playbooks');
        await expect(playbooks.getByTestId('playbook-card').first()).toBeVisible();

        const searchBox = page.getByLabel('Search the catalog');
        await searchBox.fill('weekly operations');
        await expect(playbooks.getByTestId('playbook-card')).toHaveCount(1, { timeout: 10_000 });
        await expect(page.getByTestId('catalog-section-count')).toHaveCount(5);

        await searchBox.fill('zzzqqq-nothing');
        await expect(page.getByTestId('catalog-no-results')).toBeVisible();
        await page.getByRole('button', { name: 'Clear' }).click();
        await expect(page.getByTestId('catalog-no-results')).toBeHidden();

        await page
            .locator('[data-testid="playbook-card"][data-slug="weekly-operations-report"]')
            .click();
        await expect(page).toHaveURL(/\/catalog\/playbooks\/weekly-operations-report/, {
            timeout: 30_000,
        });
        const detail = page.getByTestId('playbook-detail');
        await expect(
            detail.getByRole('heading', { level: 1, name: 'Weekly operations report' }),
        ).toBeVisible();
        for (const label of [
            'When it runs',
            'What it costs',
            'The steps',
            'What it produces',
            'When it stops and asks',
            'Its own limits',
            'What it may do alone',
        ]) {
            await expect(detail.getByRole('heading', { level: 2, name: label })).toBeVisible();
        }
        await expect(page.getByTestId('playbook-readiness')).toHaveAttribute('data-state', 'ready');
        await expect(page.getByTestId('playbook-primary-action')).toHaveAttribute(
            'href',
            /\/agents\/new/,
        );
    });

    test('an unknown playbook is a 404 page', async ({ page }) => {
        const response = await page.goto('/en/catalog/playbooks/no-such-playbook', {
            waitUntil: 'domcontentloaded',
        });
        expect(response?.status()).toBe(404);
    });
});
