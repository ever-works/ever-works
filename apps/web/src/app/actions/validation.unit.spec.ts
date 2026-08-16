import { describe, expect, it } from 'vitest';

import { PASSWORD_RULES } from './validation';

/**
 * EW-076 — the web password rules must never reject a password the API accepts.
 *
 * The API's contract is one regex, in `RegisterDto.password`
 * (apps/api/src/auth/dto/auth.dto.ts):
 *
 *     /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/
 *
 * The web side spelled the same rule as three separate checks, and one of them
 * disagreed: `/(\d|\W)/` where the API says `[\d\W_]`. `\W` is `[^A-Za-z0-9_]`,
 * so it excludes exactly one character the API includes — the underscore. A
 * password like `abcdefg_` was therefore accepted by the API and rejected by
 * the web layer before it ever got there, with a message ("must contain at
 * least one number or special character") that flatly contradicts the server.
 *
 * This spec is a differential test, not a restatement of the fix: it runs the
 * API's own regex and the web's rules over the same corpus and asserts the web
 * is never the stricter of the two. Copying `[\d\W_]` into an assertion would
 * pass no matter which way either side drifted.
 */

// Verbatim from apps/api/src/auth/dto/auth.dto.ts (RegisterDto.password).
// Kept as a literal on purpose: this is the contract under test, so it must be
// readable here without chasing an import across the workspace boundary.
const API_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/;

/** The web layer's verdict, assembled from the shared rules the app enforces. */
function webAccepts(password: string): boolean {
    return (
        password.length >= PASSWORD_RULES.MIN_LENGTH &&
        PASSWORD_RULES.LOWERCASE.test(password) &&
        PASSWORD_RULES.NUMBER_OR_SPECIAL.test(password)
    );
}

/**
 * Passwords spanning every way the two spellings could disagree: underscore
 * only, digit only, punctuation only, whitespace, unicode, and the plain
 * letters-only case both sides must reject.
 */
const CORPUS = [
    'abcdefg_', // underscore is the ONLY "special" — the EW-076 case
    '_abcdefgh', // leading underscore
    'ab_cd_efg', // underscores in the middle
    'password_', // realistic
    'abcdefgh1', // digit
    'abcdefgh!', // punctuation
    'abcdefgh ', // whitespace (\W)
    'abcdefgh€', // non-ASCII symbol (\W)
    'abcdefghi', // letters only — both must reject
    'ABCDEFGH1', // no lowercase — both must reject
    'abc_def', // 7 chars — both must reject on length
    'абвгдеёж1', // non-Latin lowercase + digit
];

describe('PASSWORD_RULES vs the API contract (EW-076)', () => {
    it.each(CORPUS)('web never rejects what the API accepts: %j', (password) => {
        if (API_PASSWORD_REGEX.test(password)) {
            expect(webAccepts(password)).toBe(true);
        }
    });

    it('control: the corpus really does contain passwords the API accepts', () => {
        // Without this, the assertion above is vacuously true if every sample
        // happens to fail the API regex — the check would look green while
        // testing nothing at all.
        const accepted = CORPUS.filter((p) => API_PASSWORD_REGEX.test(p));
        expect(accepted.length).toBeGreaterThan(5);
        expect(accepted).toContain('abcdefg_');
    });

    it('control: the corpus really does contain passwords the API rejects', () => {
        // And the mirror — proves the API regex is discriminating here rather
        // than accepting everything handed to it.
        //
        // `абвгдеёж1` is in this list because the API's `(?=.*[a-z])` is ASCII
        // only, so an all-Cyrillic password has no "lowercase letter" as far as
        // it is concerned. That is arguably its own defect in an app shipping
        // 21 locales, but it is the API's rule and `PASSWORD_RULES.LOWERCASE`
        // is `/[a-z]/` too — the two agree, which is all this file is about.
        expect(CORPUS.filter((p) => !API_PASSWORD_REGEX.test(p))).toEqual([
            'abcdefghi',
            'ABCDEFGH1',
            'abc_def',
            'абвгдеёж1',
        ]);
    });

    it('the underscore counts as a special character, as it does on the API', () => {
        // The single character the old `/(\d|\W)/` got wrong, pinned directly.
        expect(PASSWORD_RULES.NUMBER_OR_SPECIAL.test('_')).toBe(true);
        expect(/(\d|\W)/.test('_')).toBe(false); // the old spelling, for contrast
    });

    it('still rejects a password with neither a number nor a special character', () => {
        // The rule must not have been widened into uselessness to make the
        // underscore pass — `[\d\W_]` matches no plain letter.
        expect(PASSWORD_RULES.NUMBER_OR_SPECIAL.test('abcdefghi')).toBe(false);
        expect(webAccepts('abcdefghi')).toBe(false);
    });

    it('the rules are stateless — no `g` flag carrying lastIndex between calls', () => {
        // A `g`-flagged shared regex returns alternating true/false across
        // calls; these constants are module-level and reused per keystroke.
        for (const rule of Object.values(PASSWORD_RULES)) {
            if (rule instanceof RegExp) expect(rule.global).toBe(false);
        }
        expect(PASSWORD_RULES.LOWERCASE.test('abc')).toBe(true);
        expect(PASSWORD_RULES.LOWERCASE.test('abc')).toBe(true);
    });
});
