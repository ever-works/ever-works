import { test, expect } from '@playwright/test';
import { isThrottleKeyCorsNoise } from './helpers/console-noise';
import {
    gotoMemoryFacts,
    listFactsViaAPI,
    rememberViaAPI,
    searchFacts,
    withFreshMemoryUser,
} from './helpers/memory-facts';

/**
 * Memory ▸ Facts — search without meaning-based matching (AW-07).
 *
 * The e2e stack has no embedding provider and no wired vector store, which is
 * exactly the degraded mode an install without an AI provider runs in. The
 * contract there: search still works as an exact-words match, the note says
 * so and links to plugin settings, and nothing errors — no failed request, no
 * uncaught page error, no console error from the facts surface.
 *
 * The console assertion is deliberately NARROW (console and uncaught page
 * errors that name the facts surface) rather than "zero console errors": the
 * dev stack emits a known baseline of unrelated errors on every dashboard
 * route (see `flow-hydration-no-errors.spec.ts`).
 */

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe('Memory facts — degraded search', () => {
    test('exact-words search works, the note links to settings, and nothing errors', async ({
        browser,
        request,
    }) => {
        test.setTimeout(120_000);
        await withFreshMemoryUser(browser, request, async ({ user, page }) => {
            const token = user.access_token;
            const match = await rememberViaAPI(
                request,
                token,
                `We never quote a delivery date shorter than ten working days ${RUN}`,
            );
            const other = await rememberViaAPI(request, token, `Invoices go out on the 1st ${RUN}`);

            // Precondition, measured rather than assumed: this stack cannot match
            // by meaning. If it ever can, this spec is no longer testing the
            // degraded path and says so.
            const probe = await listFactsViaAPI(
                request,
                token,
                `?q=${encodeURIComponent('delivery')}`,
            );
            test.skip(
                probe.semantic,
                'this stack has meaning-based search — degraded path not reachable',
            );
            expect(probe.facts.map((f) => f.id)).toEqual([match.id]);

            const factErrors: string[] = [];
            const pageErrors: string[] = [];
            page.on('console', (msg) => {
                if (msg.type() !== 'error') return;
                const text = msg.text();
                if (isThrottleKeyCorsNoise(text)) return;
                if (/memory\/facts|FactsPanel|FactRow/i.test(text)) factErrors.push(text);
            });
            page.on('pageerror', (err) => {
                const text = [err.message, err.stack ?? ''].join(' ');
                if (/memory\/facts|FactsPanel|FactRow|FactComposer|MemoryRail/i.test(text)) {
                    pageErrors.push(err.message);
                }
            });
            const failedFactRequests: string[] = [];
            page.on('response', (res) => {
                if (res.url().includes('/api/memory/facts') && res.status() >= 400) {
                    failedFactRequests.push(`${res.status()} ${res.url()}`);
                }
            });

            const panel = await gotoMemoryFacts(page);
            const matchRow = panel.getByTestId(`fact-row-${match.id}`);
            await searchFacts(panel, 'DELIVERY date', panel.getByTestId('memory-facts-degraded'));

            await expect(matchRow).toBeVisible({ timeout: 15_000 });
            await expect(panel.getByTestId(`fact-row-${other.id}`)).toBeHidden();
            await expect(matchRow).toContainText('Contains your words');

            const note = panel.getByTestId('memory-facts-degraded');
            await expect(note).toContainText(
                'Matching by exact words — meaning-based search needs an AI provider.',
            );
            await expect(panel.getByTestId('memory-facts-degraded-cta')).toHaveAttribute(
                'href',
                /\/plugins$/,
            );

            // No results is a state, not an error.
            await searchFacts(
                panel,
                `zzz-${RUN}-nothing`,
                panel.getByTestId('memory-facts-no-results'),
            );

            expect(failedFactRequests, 'no failed /api/memory/facts request').toEqual([]);
            expect(factErrors, 'no console error from the facts surface').toEqual([]);
            expect(pageErrors, 'no uncaught page error from the facts surface').toEqual([]);
        });
    });
});
