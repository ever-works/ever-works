import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Open-redirect prevention — pass 12. `?next=`, `?redirect=`,
 * `?returnTo=` and similar query params are common across login /
 * register flows. The server must NEVER blindly redirect to an
 * external host — only same-origin paths.
 */

const REDIRECT_PARAMS = ['next', 'redirect', 'returnTo', 'continueTo', 'callbackUrl'];
const EVIL_TARGETS = [
    'https://attacker.example.com',
    'https://attacker.example.com/phish',
    '//attacker.example.com',
    'https://app.ever.works.attacker.example.com', // subdomain confusion
    'javascript:alert(1)',
];

test.describe('Open redirect — login flow', () => {
    for (const param of REDIRECT_PARAMS) {
        for (const target of EVIL_TARGETS) {
            test(`/en/login?${param}=<evil> does not redirect off-origin (${target.slice(0, 30)})`, async ({
                page,
                baseURL,
            }) => {
                const base = baseURL || 'http://localhost:3000';
                const res = await page.goto(
                    `${base}/en/login?${param}=${encodeURIComponent(target)}`,
                    { waitUntil: 'domcontentloaded' },
                );
                if (!res) test.skip(true, 'no response');
                expect(res!.status()).toBeLessThan(500);
                // After load, the page URL must still be on our origin.
                const finalUrl = page.url();
                expect(finalUrl.startsWith(base), `landed off-origin: ${finalUrl}`).toBe(true);
                // The href must NOT contain the evil host AS the host.
                const parsed = new URL(finalUrl);
                expect(
                    parsed.host.includes('attacker.example.com'),
                    `URL host hijacked: ${parsed.host}`,
                ).toBe(false);
            });
        }
    }
});

test.describe('Open redirect — API callback', () => {
    test('/api/oauth/github/callback?state=...&code=... does not redirect off-origin', async ({
        request,
    }) => {
        const res = await request.get(
            `${API_BASE}/api/oauth/github/callback?code=x&state=x&redirect_to=https://attacker.example.com`,
            { maxRedirects: 0 },
        );
        // The endpoint should 4xx (no valid state) — never 3xx to the
        // attacker domain.
        expect(res.status()).toBeLessThan(500);
        if (res.status() >= 300 && res.status() < 400) {
            const location = res.headers()['location'] || '';
            expect(
                location.includes('attacker.example.com'),
                `OAuth callback redirected to attacker: ${location}`,
            ).toBe(false);
        }
    });
});

test.describe('Open redirect — javascript: protocol blocked', () => {
    test('/en/login?next=javascript:... never executes the payload', async ({ page, baseURL }) => {
        // We don't actually trigger the redirect; we just verify the
        // page didn't navigate to a javascript: URL on load.
        const base = baseURL || 'http://localhost:3000';
        await page.goto(`${base}/en/login?next=${encodeURIComponent('javascript:alert(1)')}`, {
            waitUntil: 'domcontentloaded',
        });
        const url = page.url();
        expect(url.startsWith('javascript:'), `landed on javascript URL: ${url}`).toBe(false);
    });
});
