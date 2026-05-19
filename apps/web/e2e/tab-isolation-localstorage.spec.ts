import { test, expect } from '@playwright/test';

/**
 * Tab isolation — pass 19. Two pages with two contexts must not share
 * each other's localStorage. We open two BrowserContexts and write a
 * unique sentinel in tab A's localStorage. Tab B (different context)
 * must read `null`.
 *
 * If the platform stores transient form state in localStorage, this
 * also guards against form-state bleed across browser sessions.
 */

test.describe('Tab isolation — separate BrowserContexts do not share localStorage', () => {
    test('sentinel written by tab A is not visible to tab B in a fresh context', async ({
        browser,
        baseURL,
    }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const tabA = await ctxA.newPage();
        const tabB = await ctxB.newPage();
        await tabA.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await tabB.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const sentinel = `tab-iso-${Date.now().toString(36)}`;
        await tabA.evaluate((v: string) => {
            try {
                window.localStorage.setItem('e2e-tab-iso', v);
            } catch {
                /* ignore */
            }
        }, sentinel);
        const seenInB = await tabB.evaluate(() => {
            try {
                return window.localStorage.getItem('e2e-tab-iso');
            } catch {
                return null;
            }
        });
        await ctxA.close();
        await ctxB.close();
        expect(
            seenInB,
            "tab B read tab A's localStorage sentinel — contexts are not isolated",
        ).toBe(null);
    });

    test('two tabs in the SAME context DO share localStorage (sanity)', async ({
        browser,
        baseURL,
    }) => {
        const ctx = await browser.newContext();
        const tabA = await ctx.newPage();
        const tabB = await ctx.newPage();
        await tabA.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        await tabB.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const sentinel = `same-ctx-${Date.now().toString(36)}`;
        await tabA.evaluate((v: string) => {
            try {
                window.localStorage.setItem('e2e-same-ctx', v);
            } catch {
                /* ignore */
            }
        }, sentinel);
        const seenInB = await tabB.evaluate(() => {
            try {
                return window.localStorage.getItem('e2e-same-ctx');
            } catch {
                return null;
            }
        });
        await ctx.close();
        // Same-context tabs SHARE storage — sanity check that the
        // browser model still behaves this way.
        expect(seenInB, 'same-context tabs unexpectedly not sharing localStorage').toBe(sentinel);
    });
});
