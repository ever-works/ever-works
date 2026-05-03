import { test, expect } from '@playwright/test';

/**
 * Verifies the Directory→Work rename: routes, copy, and i18n keys all
 * resolve to the new vocabulary. Runs without authenticated state.
 *
 * NOTE: this file deliberately mentions the OLD term "directory" /
 * "directories" inside string literals so the bulk-rename script does
 * NOT rewrite them. Keep the regex literals exactly as-is.
 */

test.describe('Works rename — routes & copy', () => {
    test('protected /en/works route exists and redirects unauth user to login', async ({
        page,
    }) => {
        await page.goto('/en/works', { waitUntil: 'networkidle' });
        await expect(page).toHaveURL(/\/login/);
    });

    test('protected /en/works/new route exists and redirects unauth user to login', async ({
        page,
    }) => {
        await page.goto('/en/works/new', { waitUntil: 'networkidle' });
        await expect(page).toHaveURL(/\/login/);
    });

    test('old "/en/dir" + "/en/dir" + "/en/dir" URL no longer exists (404 or redirect)', async ({
        page,
    }) => {
        // Construct the old slug at runtime so the bulk rename script doesn't
        // see it as a literal. The old URL was `/en/<old-slug>` where
        // <old-slug> is the previous word for the entity.
        const oldSlug = ['di', 'rec', 'tories'].join('');
        const response = await page.goto(`/en/${oldSlug}`, { waitUntil: 'networkidle' });
        const isNotFound = response?.status() === 404;
        const navigatedAway = !page.url().includes(`/${oldSlug}`);
        expect(isNotFound || navigatedAway, `old /${oldSlug} should be gone`).toBe(true);
    });

    test('register page subtitle uses new "works" copy (en)', async ({ page }) => {
        await page.goto('/en/register', { waitUntil: 'networkidle' });
        await expect(page.getByText(/start building amazing works today/i)).toBeVisible();
    });

    test('auth feature panel uses new "Build Works with AI" copy', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        await expect(page.getByText(/build works with ai/i)).toBeVisible();
    });

    test('register page does NOT contain old terminology', async ({ page }) => {
        await page.goto('/en/register', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        // Construct the old word at runtime so the bulk-rename script never
        // sees it in this literal. Capital-D and lowercase variants both checked.
        const old = ['Di', 'rectory'].join('');
        const oldPlural = ['di', 'rectories'].join('');
        expect(body, `register body must not contain "${old}"`).not.toMatch(
            new RegExp(`\\b${old}\\b`),
        );
        expect(body, `register body must not contain "${oldPlural}"`).not.toMatch(
            new RegExp(`\\b${oldPlural}\\b`, 'i'),
        );
    });

    test('login page does NOT contain old terminology', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        const old = ['Di', 'rectory'].join('');
        const oldPlural = ['di', 'rectories'].join('');
        expect(body, `login body must not contain "${old}"`).not.toMatch(
            new RegExp(`\\b${old}\\b`),
        );
        expect(body, `login body must not contain "${oldPlural}"`).not.toMatch(
            new RegExp(`\\b${oldPlural}\\b`, 'i'),
        );
    });

    test('French locale shows translated "Travaux" copy on register page', async ({ page }) => {
        await page.goto('/fr/register', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        expect(body, 'French page mentions travaux/travail somewhere').toMatch(/travaux|travail/i);
        // Constructed at runtime so the sweep doesn't rewrite the literal.
        const oldFr = ['rép', 'ertoire'].join('');
        expect(body, `French page no longer mentions ${oldFr}`).not.toMatch(new RegExp(oldFr, 'i'));
    });

    test('German locale shows translated "Werke" copy on register page', async ({ page }) => {
        await page.goto('/de/register', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        expect(body, 'German page mentions Werk/Werke').toMatch(/werk/i);
        const oldDe = ['Verz', 'eichnis'].join('');
        expect(body, `German page no longer mentions ${oldDe}`).not.toMatch(new RegExp(oldDe, 'i'));
    });

    test('Spanish locale shows translated "Trabajos" copy', async ({ page }) => {
        await page.goto('/es/register', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        expect(body, 'Spanish page mentions trabajo/trabajos').toMatch(/trabajo/i);
        const oldEs = ['di', 'rectorio'].join('');
        expect(body, `Spanish page no longer mentions ${oldEs}`).not.toMatch(
            new RegExp(oldEs, 'i'),
        );
    });
});
