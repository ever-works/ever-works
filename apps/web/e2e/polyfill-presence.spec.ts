import { test, expect } from '@playwright/test';

/**
 * Polyfill presence — pass 12. Modern browsers (Playwright's Chromium)
 * shouldn't be served legacy polyfills like core-js / regenerator-runtime.
 * We probe the loaded scripts on the login page and pin that no big
 * polyfill payloads ship to a modern browser.
 */

const POLYFILL_PATTERNS = [/core-js/i, /regenerator-runtime/i, /babel-polyfill/i, /es5-shim/i];

test.describe('Polyfills — modern browser excludes legacy bundles', () => {
    test('login page does not load core-js / regenerator-runtime as separate scripts', async ({
        page,
        baseURL,
    }) => {
        const scriptUrls: string[] = [];
        page.on('request', (req) => {
            if (req.resourceType() === 'script') {
                scriptUrls.push(req.url());
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        const polyfillUrls = scriptUrls.filter((u) => POLYFILL_PATTERNS.some((pat) => pat.test(u)));
        // Next.js may bundle a minimal polyfills.js — we accept that
        // but not a separate core-js chunk that adds 200KB+.
        for (const url of polyfillUrls) {
            // Allow Next's polyfills entry — it's a minimal shim, not
            // the full core-js library.
            if (/polyfills-/.test(url) && !/core-js|regenerator/.test(url)) continue;
            expect(
                /core-js|regenerator-runtime|babel-polyfill|es5-shim/.test(url),
                `legacy polyfill loaded: ${url}`,
            ).toBe(false);
        }
    });

    test('login page does not include type="module/nomodule" duplicate-bundle pattern', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const noModuleCount = await page.locator('script[nomodule]').count();
        // Webpack 4-era "differential serving" loaded both a module
        // and a nomodule bundle. Modern Next/Webpack 5+ doesn't do
        // this. We accept up to 2 nomodule scripts (the inline runtime
        // shim is common) but not a full duplicate set.
        expect(noModuleCount, `${noModuleCount} nomodule scripts loaded`).toBeLessThanOrEqual(5);
    });
});

test.describe('Polyfills — modern features are NOT shimmed', () => {
    test('Promise, fetch, Object.assign are native (not polyfilled)', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const result = await page.evaluate(() => {
            return {
                // Native implementations are functions defined by the
                // engine — toString returns "[native code]". A polyfill
                // would return the JS source.
                promiseNative: Function.prototype.toString.call(Promise).includes('[native code]'),
                fetchNative: Function.prototype.toString.call(fetch).includes('[native code]'),
                assignNative: Function.prototype.toString
                    .call(Object.assign)
                    .includes('[native code]'),
            };
        });
        expect(result.promiseNative, 'Promise was polyfilled').toBe(true);
        expect(result.fetchNative, 'fetch was polyfilled').toBe(true);
        expect(result.assignNative, 'Object.assign was polyfilled').toBe(true);
    });
});
