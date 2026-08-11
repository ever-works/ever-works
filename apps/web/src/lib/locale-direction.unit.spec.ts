import { describe, expect, it } from 'vitest';
import { LOCALES, RTL_LOCALES, localeDirection } from './constants';

/**
 * `<html dir>` was never set, so Arabic and Hebrew rendered left-to-right.
 * Verified live on app-dev.ever.works: with the locale switched to Arabic the
 * page reported `lang="ar"` and 530 Arabic characters, yet **no element in the
 * document carried a `dir` attribute** and the computed direction from `<main>`
 * up to `<html>` was `ltr` at every level.
 *
 * The e2e guard passed throughout because it asserted `not.toBe('ltr')`, and
 * `document.documentElement.dir` is the empty string when unset.
 *
 * These tests pin the helper. The e2e spec pins the rendered attribute and the
 * computed direction; both are needed, because a correct helper still leaves
 * the layout backwards if nothing consumes it.
 */
describe('localeDirection', () => {
    it('returns rtl for the right-to-left locales this app ships', () => {
        expect(localeDirection('ar')).toBe('rtl');
        expect(localeDirection('he')).toBe('rtl');
    });

    it('returns ltr for left-to-right locales', () => {
        for (const locale of ['en', 'de', 'fr', 'ja', 'zh', 'ru']) {
            expect(localeDirection(locale), `${locale} should be ltr`).toBe('ltr');
        }
    });

    it('defaults to ltr for an unknown locale rather than throwing', () => {
        // A bad path segment must not break rendering — the route guard is what
        // rejects unknown locales, not this helper.
        expect(localeDirection('not-a-locale')).toBe('ltr');
        expect(localeDirection('')).toBe('ltr');
    });

    it('never marks a locale rtl that the app does not ship', () => {
        // Control: keeps the set honest. `fa`/`ur` are genuinely RTL languages
        // but are not in LOCALES, so claiming them here would be a lie that the
        // e2e spec (which skips unshipped locales on 404) could not catch.
        for (const locale of RTL_LOCALES) {
            expect(LOCALES as readonly string[]).toContain(locale);
        }
    });

    it('covers every shipped locale with a direction', () => {
        for (const locale of LOCALES) {
            expect(['rtl', 'ltr']).toContain(localeDirection(locale));
        }
    });
});
