import { test, expect } from '@playwright/test';
import {
    clickUntilVisible,
    gotoMemoryFacts,
    listFactsViaAPI,
    rememberViaAPI,
    searchFacts,
    withFreshMemoryUser,
} from './helpers/memory-facts';

/**
 * Memory ▸ Facts (AW-07) — the owner's journey, through the real UI.
 *
 *   empty workspace → add a fact → find it → correct it in place →
 *   forget it → Undo → forget again → restore it from Forgotten
 *
 * plus the no-results state ("Clear search" / "Add … as a fact").
 *
 * Every flow runs on a fresh user in an isolated browser context (see
 * `helpers/memory-facts.ts`): facts are workspace data, and a sibling spec
 * forgets every fact in its workspace. Assertions are scoped to the facts
 * panel (`memory-facts-panel`) — never unscoped `getByRole` — so the rest of
 * the Memory page cannot collide with them.
 *
 * Not asserted here: meaning-based matching. The e2e stack has no embedding
 * provider, so search runs as an exact-words match — that degraded path is
 * `flow-memory-facts-degraded-search.spec.ts`.
 */

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe('Memory facts — journey', () => {
    test('a brand-new workspace shows the empty state, and a fact can be added from it', async ({
        browser,
        request,
    }) => {
        test.setTimeout(120_000);
        await withFreshMemoryUser(browser, request, async ({ user, page }) => {
            const panel = await gotoMemoryFacts(page);

            const empty = panel.getByTestId('memory-facts-empty');
            await expect(empty).toBeVisible();
            await expect(empty).toContainText('Nothing remembered yet');

            const composerInput = panel.getByTestId('memory-facts-composer-input');
            await clickUntilVisible(panel.getByTestId('memory-facts-add-first'), composerInput);

            const body = `We never quote a delivery date shorter than ten working days ${RUN}`;
            await composerInput.fill(body);
            await expect(panel.getByTestId('memory-facts-composer-counter')).toContainText('/ 500');
            await panel.getByTestId('memory-facts-composer-save').click();

            await expect(panel.getByText(body, { exact: true })).toBeVisible({ timeout: 15_000 });
            await expect(empty).toBeHidden();
            await expect(panel.getByTestId('memory-rail-count-all')).toHaveText('1');

            // The row is real: the API holds it as an ACTIVE fact written by the person.
            const listed = await listFactsViaAPI(request, user.access_token);
            expect(listed.facts.map((f) => f.body)).toContain(body);
            expect(listed.facts.find((f) => f.body === body)?.status).toBe('active');
        });
    });

    test('find a fact, correct it in place, and the edit survives a reload', async ({
        browser,
        request,
    }) => {
        test.setTimeout(120_000);
        await withFreshMemoryUser(browser, request, async ({ user, page }) => {
            const fact = await rememberViaAPI(
                request,
                user.access_token,
                `Escalate anything over 5,000 to a human ${RUN}`,
            );
            const invoices = await rememberViaAPI(
                request,
                user.access_token,
                `Invoices go out on the first working day ${RUN}`,
            );

            const panel = await gotoMemoryFacts(page);
            const row = panel.getByTestId(`fact-row-${fact.id}`);
            await expect(row).toBeVisible();
            const invoicesRow = panel.getByTestId(`fact-row-${invoices.id}`);
            await expect(invoicesRow).toBeVisible();

            // The search has run once the fact it excludes is gone.
            await searchFacts(panel, 'escalate anything', invoicesRow, 'hidden');
            await expect(row).toBeVisible();

            const editInput = panel.getByTestId(`fact-edit-${fact.id}-input`);
            await clickUntilVisible(panel.getByTestId(`fact-edit-button-${fact.id}`), editInput);
            const corrected = `Escalate anything over 2,000 to a human ${RUN}`;
            await editInput.fill(corrected);
            await panel.getByTestId(`fact-edit-${fact.id}-save`).click();

            await expect(panel.getByTestId(`fact-body-${fact.id}`)).toHaveText(corrected, {
                timeout: 15_000,
            });

            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(page.getByTestId(`fact-body-${fact.id}`)).toHaveText(corrected, {
                timeout: 30_000,
            });
        });
    });

    test('forget offers Undo, and a forgotten fact can be restored from Forgotten', async ({
        browser,
        request,
    }) => {
        test.setTimeout(150_000);
        await withFreshMemoryUser(browser, request, async ({ user, page }) => {
            const fact = await rememberViaAPI(
                request,
                user.access_token,
                `The staging database never holds real data ${RUN}`,
            );

            const panel = await gotoMemoryFacts(page);
            const row = panel.getByTestId(`fact-row-${fact.id}`);
            await expect(row).toBeVisible();

            // Forget → the row leaves the list and the toast offers Undo.
            const undo = page.getByRole('button', { name: 'Undo' });
            await clickUntilVisible(panel.getByTestId(`fact-forget-button-${fact.id}`), undo);
            await expect(row).toBeHidden();
            await expect(
                page.getByText('Forgotten. Agents stop using it from their next run.'),
            ).toBeVisible();

            await undo.click();
            await expect(row).toBeVisible({ timeout: 15_000 });
            expect((await listFactsViaAPI(request, user.access_token)).counts.active).toBe(1);

            // Forget again, then restore from the Forgotten view.
            await panel.getByTestId(`fact-forget-button-${fact.id}`).click();
            await expect(row).toBeHidden({ timeout: 15_000 });

            await panel.getByTestId('memory-rail-view-forgotten').click();
            await expect(panel.getByTestId('memory-rail-view-forgotten')).toHaveAttribute(
                'aria-selected',
                'true',
            );
            const restore = panel.getByTestId(`fact-restore-button-${fact.id}`);
            await expect(restore).toBeVisible({ timeout: 15_000 });
            await expect(panel.getByTestId(`fact-row-${fact.id}`)).toContainText(
                'Restorable until',
            );
            await restore.click();
            await expect(panel.getByTestId(`fact-row-${fact.id}`)).toBeHidden({ timeout: 15_000 });

            await panel.getByTestId('memory-rail-view-all').click();
            await expect(panel.getByTestId(`fact-row-${fact.id}`)).toBeVisible({ timeout: 15_000 });
            const after = await listFactsViaAPI(request, user.access_token);
            expect(after.counts).toMatchObject({ active: 1, forgotten: 0 });
        });
    });

    test('a search with no match offers Clear search and to add the query as a fact', async ({
        browser,
        request,
    }) => {
        test.setTimeout(120_000);
        await withFreshMemoryUser(browser, request, async ({ user, page }) => {
            const fact = await rememberViaAPI(
                request,
                user.access_token,
                `Rush orders take five days ${RUN}`,
            );

            const panel = await gotoMemoryFacts(page);
            const noResults = panel.getByTestId('memory-facts-no-results');
            const query = `refund policy ${RUN}`;
            await searchFacts(panel, query, noResults);
            await expect(noResults).toContainText(`No fact matches “${query}”`);

            await panel.getByTestId('memory-facts-add-query').click();
            await expect(panel.getByTestId('memory-facts-composer-input')).toHaveValue(query);

            await panel.getByTestId('memory-facts-clear-search').click();
            await expect(panel.getByTestId('memory-facts-search')).toHaveValue('');
            await expect(panel.getByTestId(`fact-row-${fact.id}`)).toBeVisible({ timeout: 15_000 });
        });
    });
});
