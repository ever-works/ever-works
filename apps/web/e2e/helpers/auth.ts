import { type Page, expect } from '@playwright/test';

/**
 * Register a new user via the UI.
 */
export async function registerViaUI(
    page: Page,
    user: { name: string; email: string; password: string },
) {
    await page.goto('/en/register');

    await page.locator('input[name="name"]').fill(user.name);
    await page.locator('input[name="email"]').fill(user.email);
    await page.locator('input[name="password"]').fill(user.password);
    await page.locator('input[name="confirmPassword"]').fill(user.password);
    await page.locator('#terms').check();

    await page.locator('button[type="submit"]').click();

    // Wait for redirect to dashboard
    await page.waitForURL(/\/(en\/)?(works|$)/, { timeout: 15_000 });
}

/**
 * Log in an existing user via the UI.
 */
export async function loginViaUI(page: Page, credentials: { email: string; password: string }) {
    await page.goto('/en/login');

    await page.locator('input[name="email"]').fill(credentials.email);
    await page.locator('input[name="password"]').fill(credentials.password);

    await page.locator('button[type="submit"]').click();

    // Wait for redirect to dashboard
    await page.waitForURL(/\/(en\/)?(works|$)/, { timeout: 15_000 });
}

/**
 * Register a user via the API directly (faster than UI for setup).
 */
export async function registerViaAPI(
    baseURL: string,
    user: { name: string; email: string; password: string },
): Promise<{ access_token: string; refresh_token: string }> {
    const apiURL = process.env.API_URL || 'http://localhost:3100';

    const res = await fetch(`${apiURL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: user.name,
            email: user.email,
            password: user.password,
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Registration API failed (${res.status}): ${body}`);
    }

    return res.json();
}

/**
 * Log in via the API directly (faster than UI for test setup).
 */
export async function loginViaAPI(
    baseURL: string,
    credentials: { email: string; password: string },
): Promise<{ access_token: string; refresh_token: string }> {
    const apiURL = process.env.API_URL || 'http://localhost:3100';

    const res = await fetch(`${apiURL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: credentials.email,
            password: credentials.password,
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Login API failed (${res.status}): ${body}`);
    }

    return res.json();
}
