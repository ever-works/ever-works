import { test, expect } from '@playwright/test';

/**
 * Iframe sandbox — pass 13. Any embedded iframe (OAuth provider
 * iframes, video embeds, third-party widgets) MUST carry a
 * restrictive `sandbox` attribute. Without it, the embedded content
 * runs with full page privileges + can read parent cookies.
 */

const ROUTES_TO_CHECK = ['/en/login', '/en/register', '/en'];

test.describe('Iframe sandbox — restrictive embed attributes', () => {
    for (const route of ROUTES_TO_CHECK) {
        test(`${route} — any iframes carry restrictive sandbox`, async ({ page, baseURL }) => {
            await page.goto(`${baseURL || 'http://localhost:3000'}${route}`, {
                waitUntil: 'domcontentloaded',
            });
            await page.waitForTimeout(1_500);
            const iframes = await page.$$eval('iframe', (els) =>
                els.map((f) => ({
                    src: f.getAttribute('src') || '',
                    sandbox: f.getAttribute('sandbox'),
                    referrerpolicy: f.getAttribute('referrerpolicy'),
                    allow: f.getAttribute('allow'),
                })),
            );
            if (iframes.length === 0) {
                test.skip(true, `no iframes on ${route}`);
            }
            for (const f of iframes) {
                // Same-origin iframes don't need sandbox (they share
                // the document's privileges anyway). Cross-origin
                // iframes MUST sandbox.
                const isCrossOrigin =
                    f.src.startsWith('http') &&
                    !f.src.includes('localhost') &&
                    !f.src.includes('ever.works');
                if (!isCrossOrigin) continue;
                expect(f.sandbox, `cross-origin iframe ${f.src} missing sandbox`).not.toBeNull();
                // Sandbox MUST NOT allow both `allow-scripts` AND
                // `allow-same-origin` — that combo is equivalent to no
                // sandbox.
                if (f.sandbox) {
                    const tokens = f.sandbox.split(/\s+/);
                    const hasBoth =
                        tokens.includes('allow-scripts') && tokens.includes('allow-same-origin');
                    expect(
                        hasBoth,
                        `iframe ${f.src} has both allow-scripts + allow-same-origin — equivalent to no sandbox`,
                    ).toBe(false);
                }
            }
        });
    }
});

test.describe('Iframe — no `allow=*` for sensitive features', () => {
    test('iframes do not grant camera/microphone/payment via allow=*', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const iframes = await page.$$eval('iframe', (els) =>
            els.map((f) => ({
                src: f.getAttribute('src') || '',
                allow: f.getAttribute('allow') || '',
            })),
        );
        for (const f of iframes) {
            for (const feat of ['camera', 'microphone', 'payment', 'geolocation']) {
                const wildcardClause = new RegExp(`${feat}\\s+\\*`, 'i');
                expect(
                    wildcardClause.test(f.allow),
                    `iframe ${f.src} grants ${feat}=* to all origins`,
                ).toBe(false);
            }
        }
    });
});
