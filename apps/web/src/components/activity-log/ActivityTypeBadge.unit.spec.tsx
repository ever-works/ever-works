import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActivityTypeBadge } from './ActivityTypeBadge';

/**
 * APW-11 T32 (XC-24) — the `app_launcher` Activity row, in a locale that is not
 * English.
 *
 * `ActivityTypeBadge` translates a row whenever `TYPE_TO_I18N` names its
 * `actionType`, and otherwise shows `actionType.replace(/_/g, ' ')` — the raw
 * wire value. So a missing entry is not a crash and not a blank: it is the
 * words "app launcher" appearing in a German, Japanese or Arabic UI, which is
 * exactly the failure this spec exists to catch, and it is invisible in an
 * English screenshot.
 *
 * Two things make the assertion mean something:
 *
 *  1. **The translator reads the real bundle.** The `next-intl` mock resolves
 *     `dashboard.activity.<key>` out of `messages/<locale>.json`, the file the
 *     app itself loads, so the test fails when the key is missing from a locale
 *     as well as when the component forgets to ask for it. A mock that echoed
 *     the key back would pass for both faults.
 *  2. **There is a control.** An unmapped action type must still fall through to
 *     the raw label, so "no raw text anywhere" cannot be what is being
 *     asserted — the fallback is a feature, and it stays.
 *
 * The keys are also asserted across all 21 bundled locales, because T32's
 * requirement is "in every locale, in this PR" and nothing else checks that.
 */

const MESSAGES_DIR = resolve(process.cwd(), 'messages');

/** The locale the rendered assertions use — not English, and not the fallback. */
const LOCALE = 'de';
const GERMAN_LABEL = 'App-Starter';

const state = vi.hoisted(() => ({ locale: 'de' }));

vi.mock('next-intl', async () => {
    const { readFileSync: read } = await import('node:fs');
    const { resolve: resolvePath } = await import('node:path');

    return {
        useTranslations: (namespace: string) => (key: string) => {
            const bundle = JSON.parse(
                read(resolvePath(process.cwd(), 'messages', `${state.locale}.json`), 'utf8'),
            ) as Record<string, unknown>;

            let node: unknown = bundle;
            for (const part of `${namespace}.${key}`.split('.')) {
                if (node === null || typeof node !== 'object') return undefined;
                node = (node as Record<string, unknown>)[part];
            }
            return node;
        },
    };
});

function locales(): string[] {
    return readdirSync(MESSAGES_DIR)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace('.json', ''))
        .sort();
}

describe('ActivityTypeBadge — the app_launcher row (APW-11 T32, XC-24)', () => {
    it('renders the translated label in a non-English locale', () => {
        state.locale = LOCALE;

        render(<ActivityTypeBadge actionType="app_launcher" />);

        expect(screen.getByText(GERMAN_LABEL)).toBeTruthy();
        // The raw wire value, which is what the row shows when `TYPE_TO_I18N`
        // has no entry for it.
        expect(screen.queryByText('app launcher')).toBeNull();
    });

    it('still falls back to the raw label for a type it does not map', () => {
        // The control. `activity-log-unknown-type` is not a real action type and
        // is not in the map on purpose: if it rendered a translation instead,
        // the assertion above would be proving something other than the mapping.
        state.locale = LOCALE;

        render(<ActivityTypeBadge actionType="some_future_type" />);

        expect(screen.getByText('some future type')).toBeTruthy();
    });

    it('colours the launcher row differently from an unmapped one', () => {
        state.locale = LOCALE;

        const { container: mapped } = render(<ActivityTypeBadge actionType="app_launcher" />);
        const { container: unmapped } = render(<ActivityTypeBadge actionType="some_future_type" />);

        const mappedClass = mapped.querySelector('span')?.className ?? '';
        const unmappedClass = unmapped.querySelector('span')?.className ?? '';

        expect(mappedClass).toContain('sky');
        expect(unmappedClass).toContain('gray');
        expect(mappedClass).not.toBe(unmappedClass);
    });

    it('carries the label in every bundled locale', () => {
        const all = locales();
        // A guard on the guard: if the bundles stopped being discovered, the
        // loop below would pass without checking anything.
        expect(all.length).toBeGreaterThanOrEqual(21);
        expect(all).toContain('en');

        const missing: string[] = [];
        for (const locale of all) {
            const bundle = JSON.parse(
                readFileSync(resolve(MESSAGES_DIR, `${locale}.json`), 'utf8'),
            ) as { dashboard?: { activity?: { filters?: { types?: Record<string, string> } } } };

            const label = bundle.dashboard?.activity?.filters?.types?.appLauncher;
            if (typeof label !== 'string' || label.length === 0) {
                missing.push(locale);
            }
        }

        expect(missing).toEqual([]);
    });
});
