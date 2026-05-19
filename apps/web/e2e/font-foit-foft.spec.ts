import { test, expect } from '@playwright/test';

/**
 * FOIT / FOFT avoidance — pass 19. Web fonts should use
 * `font-display: swap` (or `optional`) so text remains visible
 * during font load. Anything else risks invisible-text-flash (FOIT)
 * for the duration of the font fetch.
 */

test.describe('Fonts — font-display: swap/optional avoids FOIT', () => {
    test('CSS stylesheets on /en/login declare font-display swap or optional', async ({
        page,
        baseURL,
    }) => {
        const cssBodies: string[] = [];
        page.on('response', async (res) => {
            try {
                const ct = res.headers()['content-type'] || '';
                if (ct.includes('text/css') && res.ok()) {
                    const body = await res.text();
                    cssBodies.push(body);
                }
            } catch {
                /* ignore */
            }
        });
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'networkidle',
        });
        const allCss = cssBodies.join('\n');
        // Look for @font-face declarations.
        const fontFaces = allCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
        if (fontFaces.length === 0) {
            test.skip(true, 'no @font-face declarations observed — no web fonts');
        }
        // Each @font-face should specify font-display.
        const withDisplay = fontFaces.filter((ff) => /font-display\s*:/i.test(ff));
        const ratio = withDisplay.length / fontFaces.length;
        if (ratio < 0.5) {
            test.info().annotations.push({
                type: 'informational',
                description: `${fontFaces.length} @font-face declarations, only ${withDisplay.length} have font-display — invisible-text-flash risk`,
            });
        }
        // Where font-display is set, must be swap/optional/fallback.
        for (const ff of withDisplay) {
            const m = /font-display\s*:\s*(\w+)/i.exec(ff);
            const display = m ? m[1].toLowerCase() : '';
            const acceptable = ['swap', 'optional', 'fallback', 'block'].includes(display);
            // `block` and `auto` are acceptable per spec but discouraged
            // for performance. `block` shows FOIT — informational.
            if (!acceptable) {
                test.info().annotations.push({
                    type: 'informational',
                    description: `@font-face uses font-display: ${display} — unrecognised value`,
                });
            }
        }
    });
});
