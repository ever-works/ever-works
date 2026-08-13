import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTranslator } from 'next-intl';

/**
 * Meetings copy — ICU syntax guard across every locale.
 *
 * next-intl parses messages as ICU MessageFormat, where `<foo>` is a
 * rich-text TAG, not literal text. An unmatched one raises
 * `INVALID_MESSAGE: UNCLOSED_TAG` and next-intl then renders the message's
 * own key path in the UI — so `fields.participantsHint` shipped reading
 * "dashboard.meetingNew.fields.participantsHint" on screen rather than the
 * hint, in all 21 locales, for as long as the roster hint has existed.
 *
 * The roster hint has to show the literal `Name <email>` format the parser
 * accepts, so the angle bracket is escaped as `'<'`. This spec pins that:
 * every message on the Meetings surface must survive a real
 * `createTranslator` round trip.
 *
 * Only INVALID_MESSAGE (a SYNTAX fault, wrong in every environment) fails
 * the spec. Missing-placeholder faults are a caller concern and depend on
 * the values a component happens to pass, so they are ignored here.
 */

// Vitest's root is `apps/web` (see vitest.config.ts), so the bundle
// directory resolves off the cwd rather than import.meta.url — which is
// not a file: URL under the Vite transform.
const MESSAGES_DIR = resolve(process.cwd(), 'messages');

/** Every namespace the Meetings surface renders from. */
const NAMESPACES = ['meetingsPage', 'meetingNew', 'meetingDetail'] as const;

/** Placeholders used anywhere in the Meetings copy. */
const VALUES = { title: 'A meeting', count: 2, from: 1, to: 10 };

type Tree = { [key: string]: string | Tree };

function leafKeys(node: Tree, prefix = ''): string[] {
    return Object.entries(node).flatMap(([key, value]) =>
        typeof value === 'string' ? [prefix + key] : leafKeys(value, `${prefix}${key}.`),
    );
}

const locales = readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort();

describe('Meetings messages — ICU syntax', () => {
    it('covers every locale bundled in the app', () => {
        // A guard on the guard: if locales stop being discovered, the suite
        // below would vacuously pass.
        expect(locales.length).toBeGreaterThanOrEqual(21);
        expect(locales).toContain('en');
    });

    for (const locale of locales) {
        it(`${locale} — every Meetings message parses`, () => {
            const messages = JSON.parse(
                readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8'),
            ) as { dashboard: Record<string, Tree> };

            const invalid: string[] = [];

            for (const namespace of NAMESPACES) {
                const tree = messages.dashboard[namespace];
                expect(tree, `${locale}: dashboard.${namespace} is missing`).toBeTruthy();

                for (const key of leafKeys(tree)) {
                    const t = createTranslator({
                        locale,
                        messages,
                        namespace: `dashboard.${namespace}`,
                        onError: (error) => {
                            const text = String(error?.message ?? error);
                            if (text.includes('INVALID_MESSAGE')) {
                                invalid.push(`dashboard.${namespace}.${key}: ${text}`);
                            }
                        },
                    });
                    // next-intl types `t` against the literal key union;
                    // this spec walks keys discovered at runtime.
                    (t as unknown as (k: string, v?: Record<string, unknown>) => string)(
                        key,
                        VALUES,
                    );
                }
            }

            expect(invalid, `${locale} has invalid ICU messages`).toEqual([]);
        });
    }

    it('the roster hint still shows the literal Name <email> format after escaping', () => {
        // Only the CAPTURE form still teaches the syntax: `/meetings/[id]`
        // edits its roster through a row editor now, so `meetingDetail` has
        // no hint left to escape.
        const messages = JSON.parse(readFileSync(join(MESSAGES_DIR, 'en.json'), 'utf8'));
        const t = createTranslator({
            locale: 'en',
            messages,
            namespace: 'dashboard.meetingNew',
            onError: (error) => {
                throw error;
            },
        });
        // The escape must survive as literal text — escaping it away
        // would "fix" the error by deleting the thing the hint teaches.
        expect(t('fields.participantsHint')).toContain('<email>');
    });
});
