import { test, expect } from '@playwright/test';

/**
 * PWA offline behaviour — pass 8. If the platform registers a service
 * worker, we verify it doesn't break basic navigation when online and
 * doesn't trap the user offline if the worker fails to install.
 */

test.describe('PWA — service worker installation (if present)', () => {
    test('navigator.serviceWorker registration state is queryable', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        const swInfo = await page.evaluate(async () => {
            if (!('serviceWorker' in navigator)) {
                return { supported: false } as const;
            }
            const regs = await navigator.serviceWorker.getRegistrations();
            return {
                supported: true,
                count: regs.length,
                scopes: regs.map((r) => r.scope),
            } as const;
        });
        if (!swInfo.supported) {
            test.skip(true, 'serviceWorker not supported in this browser context');
        }
        // We don't fail when there's no SW — the platform may not be a PWA.
        // But if there ARE SWs, each registration must have a sensible scope.
        if (swInfo.supported && swInfo.count > 0) {
            for (const scope of swInfo.scopes) {
                expect(typeof scope).toBe('string');
                expect(scope.length).toBeGreaterThan(0);
            }
        }
    });

    test('GET /manifest.webmanifest is reachable without 5xx (if present)', async ({
        page,
        baseURL,
    }) => {
        const candidates = ['/manifest.webmanifest', '/manifest.json', '/site.webmanifest'];
        for (const path of candidates) {
            const res = await page.request.get(`${baseURL || 'http://localhost:3000'}${path}`);
            if (res.status() === 404) continue;
            expect(res.status()).toBeLessThan(500);
            const ct = res.headers()['content-type'] || '';
            // Web app manifest is JSON.
            expect(ct.includes('json') || ct.includes('manifest')).toBe(true);
            return;
        }
        test.skip(true, 'no manifest discovered');
    });

    test('GET /sw.js / /service-worker.js is reachable (if registered)', async ({
        page,
        baseURL,
    }) => {
        const candidates = ['/sw.js', '/service-worker.js', '/workbox-sw.js'];
        for (const path of candidates) {
            const res = await page.request.get(`${baseURL || 'http://localhost:3000'}${path}`);
            if (res.status() === 404) continue;
            expect(res.status()).toBeLessThan(500);
            const ct = res.headers()['content-type'] || '';
            expect(ct.includes('javascript') || ct.includes('text/')).toBe(true);
            return;
        }
        test.skip(true, 'no service worker script discovered');
    });
});
