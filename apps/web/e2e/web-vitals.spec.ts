import { test, expect } from '@playwright/test';

/**
 * Web Vitals — pass 8. We inject the web-vitals JS library (already a
 * monitoring dep) via a CDN script and capture the metrics that fire
 * on first interaction. We deliberately set ceilings high enough to
 * avoid CI-noise false-positives — the point is to catch ten-fold
 * regressions, not chase 50ms wobbles.
 *
 * Budgets are coarse: LCP < 8s on dev mode is realistic; INP / CLS
 * need a real interaction we don't have to fake here, so we capture
 * what we get and merely log values that don't make it.
 */

const LCP_CEILING_MS = 8_000;
const FCP_CEILING_MS = 6_000;
const CLS_CEILING = 0.5;

async function collectVitals(
    page: import('@playwright/test').Page,
): Promise<Record<string, number>> {
    // Initialise the accumulator INSIDE the page.evaluate that follows.
    // Earlier shape used addInitScript, but Greptile P1: addInitScript
    // only takes effect on FUTURE navigations, so by the time we call
    // page.evaluate after page.goto, __vitals is still undefined and the
    // onLCP callbacks would throw outside the try/catch. Initialise on
    // the live `window` here and the issue disappears.
    return page.evaluate(async () => {
        const w = window as unknown as {
            __vitals: Record<string, number>;
            __vitalsLoaded?: boolean;
        };
        if (!w.__vitals) w.__vitals = {};
        // Load web-vitals from the official CDN. Skip if blocked.
        await new Promise<void>((resolve) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/web-vitals@3/dist/web-vitals.iife.js';
            s.onload = () => {
                w.__vitalsLoaded = true;
                resolve();
            };
            s.onerror = () => resolve();
            document.head.appendChild(s);
        });
        if (!w.__vitalsLoaded) return w.__vitals;
        const wv = (
            window as unknown as {
                webVitals?: Record<
                    string,
                    (cb: (m: { name: string; value: number }) => void) => void
                >;
            }
        ).webVitals;
        if (!wv) return w.__vitals;
        const recorders = ['onLCP', 'onFCP', 'onCLS'] as const;
        for (const name of recorders) {
            try {
                wv[name]?.((m: { name: string; value: number }) => {
                    w.__vitals[m.name] = m.value;
                });
            } catch {
                // ignore
            }
        }
        // Wait for the metrics to settle (one paint cycle + a tick).
        await new Promise((r) => setTimeout(r, 2_000));
        return w.__vitals;
    });
}

test.describe('Web Vitals — coarse SLO ceilings', () => {
    test('login page LCP / FCP / CLS within sane bounds', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        const vitals = await collectVitals(page);
        if (!vitals || Object.keys(vitals).length === 0) {
            test.skip(true, 'web-vitals could not be loaded (CDN blocked or no metrics fired)');
        }
        if (typeof vitals.LCP === 'number') {
            expect(vitals.LCP, `login LCP ${vitals.LCP}ms`).toBeLessThan(LCP_CEILING_MS);
        }
        if (typeof vitals.FCP === 'number') {
            expect(vitals.FCP, `login FCP ${vitals.FCP}ms`).toBeLessThan(FCP_CEILING_MS);
        }
        if (typeof vitals.CLS === 'number') {
            expect(vitals.CLS, `login CLS ${vitals.CLS}`).toBeLessThan(CLS_CEILING);
        }
    });

    test('register page LCP / FCP within sane bounds', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/register`, {
            waitUntil: 'networkidle',
        });
        const vitals = await collectVitals(page);
        if (!vitals || Object.keys(vitals).length === 0) {
            test.skip(true, 'web-vitals could not load');
        }
        if (typeof vitals.LCP === 'number') {
            expect(vitals.LCP, `register LCP ${vitals.LCP}ms`).toBeLessThan(LCP_CEILING_MS);
        }
        if (typeof vitals.FCP === 'number') {
            expect(vitals.FCP, `register FCP ${vitals.FCP}ms`).toBeLessThan(FCP_CEILING_MS);
        }
    });
});
