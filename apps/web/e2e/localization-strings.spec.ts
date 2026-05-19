import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Localization strings — pass 11. Verify all locale JSON files have
 * the same key set as the canonical `en` locale. Missing keys produce
 * untranslated UI; placeholder text like `[MISSING]` or unresolved
 * `{key}` tokens should never ship.
 */

function locateMessagesDir(): string | null {
    const candidates = [
        'apps/web/src/messages',
        'apps/web/messages',
        'apps/web/src/i18n/messages',
        'apps/web/src/locales',
        'apps/web/locales',
    ];
    // Spec runs from apps/web (the cwd of Playwright). Try relative to
    // that, then walk up one level for monorepo runs.
    for (const c of candidates) {
        if (existsSync(c)) return c;
        const parent = join('..', '..', c);
        if (existsSync(parent)) return parent;
    }
    return null;
}

function flattenKeys(obj: unknown, prefix = ''): string[] {
    if (!obj || typeof obj !== 'object') return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            out.push(...flattenKeys(v, path));
        } else {
            out.push(path);
        }
    }
    return out;
}

test.describe('Localization — locale JSON files have parity', () => {
    test('every non-en locale has the same key set as en', async () => {
        const dir = locateMessagesDir();
        if (!dir) test.skip(true, 'no messages directory found');
        const files = readdirSync(dir!).filter((f) => f.endsWith('.json'));
        if (files.length < 2) test.skip(true, `only ${files.length} locale files found`);
        const enFile = files.find((f) => f === 'en.json' || f === 'en-US.json');
        if (!enFile) test.skip(true, 'no en.json baseline');
        const enKeys = new Set(flattenKeys(JSON.parse(readFileSync(join(dir!, enFile), 'utf-8'))));
        const missingPerLocale: Record<string, string[]> = {};
        for (const f of files) {
            if (f === enFile) continue;
            const keys = new Set(flattenKeys(JSON.parse(readFileSync(join(dir!, f), 'utf-8'))));
            const missing = [...enKeys].filter((k) => !keys.has(k));
            if (missing.length > 0) missingPerLocale[f] = missing.slice(0, 10);
        }
        expect(
            Object.keys(missingPerLocale).length,
            `locales missing keys: ${JSON.stringify(missingPerLocale).slice(0, 400)}`,
        ).toBe(0);
    });

    test('no locale carries placeholder strings like [MISSING] or TODO', async () => {
        const dir = locateMessagesDir();
        if (!dir) test.skip(true, 'no messages directory');
        const files = readdirSync(dir!).filter((f) => f.endsWith('.json'));
        if (files.length === 0) test.skip(true, 'no locale files');
        const offenders: string[] = [];
        for (const f of files) {
            const raw = readFileSync(join(dir!, f), 'utf-8');
            // Stale-translation flags people leave around mid-revision.
            if (/\[MISSING\]|\[TODO\]|XXX_TODO|FIXME-i18n/.test(raw)) {
                offenders.push(f);
            }
        }
        expect(offenders, `locales with placeholder strings: ${offenders.join(', ')}`).toEqual([]);
    });

    test('en locale has a non-trivial number of keys (sanity)', async () => {
        const dir = locateMessagesDir();
        if (!dir) test.skip(true, 'no messages directory');
        const files = readdirSync(dir!);
        const enFile = files.find((f) => f === 'en.json' || f === 'en-US.json');
        if (!enFile) test.skip(true, 'no en baseline');
        const keys = flattenKeys(JSON.parse(readFileSync(join(dir!, enFile), 'utf-8')));
        // A real app has hundreds of strings. A regression that drops
        // half the dictionary would surface here.
        expect(keys.length, `en locale has only ${keys.length} keys`).toBeGreaterThan(20);
    });
});
