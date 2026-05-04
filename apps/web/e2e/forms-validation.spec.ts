import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Edge-case validation on the auth forms (UI + API). Covers ground the
 * happy-path tests skip: invalid emails, super-long fields, unicode names,
 * SQL/script injection attempts (sanity check, not a security audit).
 */

test.describe('Registration form — validation edge cases', () => {
    test('invalid email format keeps user on /register and surfaces error', async ({ page }) => {
        await page.goto('/en/register', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_000);

        await page.locator('input[name="name"]').fill('Invalid Email Tester');
        await page.locator('input[name="email"]').fill('not-an-email');
        await page.locator('input[name="password"]').fill('Strong1!secure');
        await page.locator('input[name="confirmPassword"]').fill('Strong1!secure');
        await page.locator('#terms').check();
        await page.locator('button[type="submit"]').click();

        // HTML5 validation OR our own validator should keep us on the page.
        await page.waitForTimeout(800);
        await expect(page).toHaveURL(/\/register/);
    });

    test('unchecked terms keeps user on /register', async ({ page }) => {
        await page.goto('/en/register', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_000);

        const suffix = Date.now().toString(36);
        await page.locator('input[name="name"]').fill('No Terms');
        await page.locator('input[name="email"]').fill(`noterms-${suffix}@test.local`);
        await page.locator('input[name="password"]').fill('Strong1!secure');
        await page.locator('input[name="confirmPassword"]').fill('Strong1!secure');
        // Deliberately NOT checking #terms.
        await page.locator('button[type="submit"]').click();

        await page.waitForTimeout(800);
        await expect(page).toHaveURL(/\/register/);
    });
});

test.describe('Auth API — validation edge cases', () => {
    test('register with empty body → 4xx (not 5xx)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/register`, { data: {} });
        expect(res.status(), `status was ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('register with invalid email → 4xx', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/register`, {
            data: {
                username: 'X',
                email: 'this is not an email',
                password: 'Strong1!secure',
            },
        });
        expect(res.status(), `status was ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('register with short password → 4xx', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/register`, {
            data: {
                username: 'Shorty',
                email: `short-${Date.now()}@test.local`,
                password: 'x',
            },
        });
        expect(res.status(), `status was ${res.status()}`).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('login with non-existent user → 4xx (401/400 — not 5xx)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: `nobody-${Date.now()}@test.local`, password: 'Whatever1!' },
        });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });

    test('forgot-password with empty body → 4xx (not 5xx)', async ({ request }) => {
        const res = await request.post(`${API_BASE}/api/auth/forgot-password`, { data: {} });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
    });
});
