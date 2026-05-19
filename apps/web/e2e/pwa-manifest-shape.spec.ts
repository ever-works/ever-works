import { test, expect } from '@playwright/test';

/**
 * PWA manifest shape — pass 19. The `/manifest.webmanifest` (or
 * `/manifest.json`) should carry the canonical PWA fields. Pass-8
 * `pwa-offline` covered "manifest is reachable"; this pass tightens
 * the shape.
 */

const MANIFEST_PATHS = ['/manifest.webmanifest', '/manifest.json', '/manifest'];

test.describe('PWA — manifest shape carries name + icons + start_url + display', () => {
    test('manifest exposes name, short_name (or name), and start_url', async ({
        page,
        baseURL,
    }) => {
        let manifest: Record<string, unknown> | null = null;
        let foundPath: string | null = null;
        for (const p of MANIFEST_PATHS) {
            const res = await page.request.get(`${baseURL || 'http://localhost:3000'}${p}`);
            if (!res.ok()) continue;
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('json') && !ct.includes('manifest')) continue;
            const body = await res.json().catch(() => null);
            if (body && typeof body === 'object') {
                manifest = body as Record<string, unknown>;
                foundPath = p;
                break;
            }
        }
        if (!manifest || !foundPath) test.skip(true, 'no manifest exposed');
        // Name OR short_name required.
        const hasName =
            typeof manifest!.name === 'string' || typeof manifest!.short_name === 'string';
        expect(hasName, `${foundPath}: manifest missing name/short_name`).toBe(true);
        // start_url is required by the spec.
        expect(
            typeof manifest!.start_url === 'string',
            `${foundPath}: manifest missing start_url`,
        ).toBe(true);
    });

    test('manifest carries icons array with at least one entry', async ({ page, baseURL }) => {
        for (const p of MANIFEST_PATHS) {
            const res = await page.request.get(`${baseURL || 'http://localhost:3000'}${p}`);
            if (!res.ok()) continue;
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('json') && !ct.includes('manifest')) continue;
            const body = await res.json().catch(() => null);
            if (!body || typeof body !== 'object') continue;
            const icons = (body as Record<string, unknown>).icons;
            expect(Array.isArray(icons), `${p}: manifest.icons is not an array`).toBe(true);
            expect(
                Array.isArray(icons) && icons.length,
                `${p}: manifest.icons is empty`,
            ).toBeGreaterThan(0);
            return;
        }
        test.skip(true, 'no manifest exposed');
    });

    test('manifest display is "standalone" / "minimal-ui" / "fullscreen" / "browser"', async ({
        page,
        baseURL,
    }) => {
        for (const p of MANIFEST_PATHS) {
            const res = await page.request.get(`${baseURL || 'http://localhost:3000'}${p}`);
            if (!res.ok()) continue;
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('json') && !ct.includes('manifest')) continue;
            const body = await res.json().catch(() => null);
            if (!body || typeof body !== 'object') continue;
            const display = (body as Record<string, unknown>).display;
            if (display === undefined) {
                // Optional field — informational.
                test.info().annotations.push({
                    type: 'informational',
                    description: `${p}: no display field — defaults to "browser"`,
                });
                return;
            }
            expect(
                ['standalone', 'minimal-ui', 'fullscreen', 'browser'].includes(String(display)),
                `${p}: invalid display "${display}"`,
            ).toBe(true);
            return;
        }
        test.skip(true, 'no manifest exposed');
    });
});
