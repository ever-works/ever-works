import { test, expect } from '@playwright/test';

/**
 * Verifies the Directory→Work rename: routes, copy, and i18n keys all
 * resolve to the new vocabulary. Runs without authenticated state.
 */

test.describe('Works rename — routes & copy', () => {
    test('protected /en/works route exists and redirects unauth user to login', async ({ page }) => {
        await page.goto('/en/works', { waitUntil: 'networkidle' });
        await expect(page).toHaveURL(/\/login/);
    });

    test('protected /en/works/new route exists and redirects unauth user to login', async ({ page }) => {
        await page.goto('/en/works/new', { waitUntil: 'networkidle' });
        await expect(page).toHaveURL(/\/login/);
    });

    test('old /en/directories URL no longer exists (404 or redirect away from /directories)', async ({
        page,
    }) => {
        const response = await page.goto('/en/directories', { waitUntil: 'networkidle' });
        // Either Next.js returns a 404 OR the route doesn't exist and the
        // user gets bounced. The KEY assertion is "we are not on a working
        // /directories page" — the URL should not stay at /directories with 200.
        const isNotFound = response?.status() === 404;
        const navigatedAway = !page.url().includes('/directories');
        expect(isNotFound || navigatedAway, 'old /directories should be gone').toBe(true);
    });

    test('register page subtitle uses new "works" copy (en)', async ({ page }) => {
        await page.goto('/en/register', { waitUntil: 'networkidle' });
        await expect(page.getByText(/start building amazing works today/i)).toBeVisible();
    });

    test('auth feature panel uses new "Build Works with AI" copy', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        await expect(page.getByText(/build works with ai/i)).toBeVisible();
    });

    test('register page does NOT contain old "Directory" terminology', async ({ page }) => {
        await page.goto('/en/register', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        // Look for the standalone word "directory"/"directories" as a noun in
        // visible UI text. Allow CSS selectors and other code-internal mentions
        // to pass — we only fail if "Directory" or "Directories" shows up in
        // the user-visible body content.
        expect(body, 'no Directory/Directories in register page body').not.toMatch(
            /\b[Dd]irectories?\b/,
        );
    });

    test('login page does NOT contain old "Directory" terminology', async ({ page }) => {
        await page.goto('/en/login', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        expect(body, 'no Directory/Directories in login page body').not.toMatch(
            /\b[Dd]irectories?\b/,
        );
    });

    test('French locale shows translated "Travaux" copy on register page', async ({ page }) => {
        await page.goto('/fr/register', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        // We expect at least one of the French translations to surface.
        // The French value for the page subtitle is now "travaux" or similar.
        expect(body, 'French page mentions travaux/travail somewhere').toMatch(/travaux|travail/i);
        expect(body, 'French page no longer mentions répertoire').not.toMatch(/répertoire/i);
    });

    test('German locale shows translated "Werke" copy on register page', async ({ page }) => {
        await page.goto('/de/register', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        expect(body, 'German page mentions Werk/Werke').toMatch(/werk/i);
        expect(body, 'German page no longer mentions Verzeichnis').not.toMatch(/verzeichnis/i);
    });

    test('Spanish locale shows translated "Trabajos" copy', async ({ page }) => {
        await page.goto('/es/register', { waitUntil: 'networkidle' });
        const body = await page.locator('body').innerText();
        expect(body, 'Spanish page mentions trabajo/trabajos').toMatch(/trabajo/i);
        expect(body, 'Spanish page no longer mentions directorio').not.toMatch(/directorio/i);
    });
});
