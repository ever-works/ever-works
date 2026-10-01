import { readFileSync, readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * APW-11 T21 (launch-parity backlog G-09, spec ACC-11-33) — the App Launcher
 * never claims single sign-on.
 *
 * The launcher opens addresses. It does not sign anyone in, and until **Ever ID**
 * (APW-12) ships, no string on a launcher surface may say or imply that it does.
 * A claim like that is not a style problem: it tells a person their session is
 * shared with an app it is not shared with.
 *
 * Two design choices make this guard worth having:
 *
 *  1. **The term list is read from the document, not copied into this file.**
 *     `no-sso-terms-draft.md` is the source; each row carries a review state, and
 *     only rows marked `reviewed` are enforced for their locale. English is
 *     enforced by a regular expression; the other twenty locales carry seeded
 *     phrases that become enforceable when a native reviewer flips their state.
 *     Copying the table here would create a second list to keep in step — exactly
 *     the drift this programme keeps paying for.
 *  2. **It scans launcher keys as they appear, not a fixed list of three
 *     namespaces.** T21 was written before the launcher's surfaces existed, so a
 *     spec pinned to `dashboard.appLauncher` and its two siblings would have
 *     scanned nothing at all and passed. This one scans every key whose path
 *     contains `appLauncher` in every bundle, so each surface that lands is
 *     covered without touching this spec — and it **fails if it scanned nothing**,
 *     so it can never pass by finding no copy.
 */

/** Vitest's root is `apps/web` (see vitest.config.ts). */
const MESSAGES_DIR = resolve(process.cwd(), 'messages');

/**
 * The repository root, found by walking up to the directory that holds
 * `.deploy/k8s`. Counting `..` would be a guess, and a spec that silently read
 * the wrong path (or nothing) is the failure this guard exists to prevent.
 */
function repoRoot(): string {
    let dir = __dirname;
    for (let depth = 0; depth < 10; depth += 1) {
        if (existsSync(join(dir, '.deploy', 'k8s'))) return dir;
        dir = join(dir, '..');
    }
    throw new Error(`repository root not found by walking up from ${__dirname}`);
}

/** The English half of the guard: what a sign-on claim looks like in English. */
const ENGLISH_PATTERN = /single sign-on|\bsso\b|one login|already signed in/i;

/** The three namespaces T21 names, so the spec can report which have landed. */
const NAMED_NAMESPACES = [
    'dashboard.appLauncher',
    'dashboard.settings.appLauncher',
    'dashboard.workDetail.settings.appLauncher',
];

interface TermRow {
    locale: string;
    file: string;
    phrases: string[];
    state: 'reviewed' | 'seeded';
}

type Tree = { [key: string]: string | Tree };

/** The term table of `no-sso-terms-draft.md`, parsed row by row. */
function termRows(): TermRow[] {
    const path = join(
        repoRoot(),
        'docs/specs/features/app-works/APW-11-app-launcher/no-sso-terms-draft.md',
    );
    const rows: TermRow[] = [];

    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const cells = line
            .split('|')
            .map((cell) => cell.trim())
            .filter((cell, index, all) => index > 0 && index < all.length - 1);
        if (cells.length < 4) continue;

        const [locale, file, phraseCell, state] = cells;
        const fileMatch = /`([a-z]{2}\.json)`/.exec(file);
        if (!fileMatch) continue;
        if (state !== 'reviewed' && state !== 'seeded') continue;

        const phrases = [...phraseCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
        rows.push({ locale, file: fileMatch[1], phrases, state });
    }

    return rows;
}

/** Every leaf of a bundle whose key path mentions `appLauncher`. */
function launcherStrings(node: Tree, path: string[] = []): Array<{ path: string; value: string }> {
    const found: Array<{ path: string; value: string }> = [];

    for (const [key, value] of Object.entries(node)) {
        const next = [...path, key];
        if (typeof value === 'string') {
            if (next.some((part) => part.toLowerCase().includes('applauncher'))) {
                found.push({ path: next.join('.'), value });
            }
            continue;
        }
        if (value && typeof value === 'object') {
            found.push(...launcherStrings(value as Tree, next));
        }
    }

    return found;
}

function locales(): string[] {
    return readdirSync(MESSAGES_DIR)
        .filter((file) => /^[a-z]{2}\.json$/.test(file))
        .map((file) => file.replace('.json', ''))
        .sort();
}

function bundle(locale: string): Tree {
    return JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as Tree;
}

describe('APW-11 T21 — the launcher never claims single sign-on', () => {
    const rows = termRows();
    const allLocales = locales();

    it('reads the term list from the document it ships beside', () => {
        // Vacuity guard: a parse that found no rows would make every assertion
        // below pass by checking nothing.
        expect(rows.length).toBeGreaterThanOrEqual(21);
        expect(rows.map((row) => row.file)).toContain('en.json');
        // English is the enforced regex; at least one row must be enforceable or
        // the per-locale half of this guard is decorative.
        expect(rows.filter((row) => row.state === 'reviewed').length).toBeGreaterThanOrEqual(1);
        for (const row of rows) {
            expect(row.phrases.length).toBeGreaterThan(0);
        }
    });

    it('scans launcher copy in every bundle, and refuses to pass when there is none', () => {
        const scanned = allLocales.flatMap((locale) =>
            launcherStrings(bundle(locale)).map((entry) => `${locale}:${entry.path}`),
        );

        // The guard's own liveness: this must find the launcher keys that exist
        // today. When the panel, the settings tab and the Work setting land, this
        // count grows by itself — and if a refactor renamed every key so nothing
        // matched, THIS is the assertion that fails, rather than a silent pass.
        expect(scanned.length).toBeGreaterThan(0);
        expect(scanned.some((entry) => entry.startsWith('en:'))).toBe(true);
    });

    it('reports which of the three named namespaces have not landed yet', () => {
        // Informational, and deliberately an assertion rather than a comment: the
        // list is the coverage this guard will grow into. A namespace that is
        // present must be among the keys the previous test scanned.
        const english = bundle('en');
        const scannedPaths = launcherStrings(english).map((entry) => entry.path);

        const present: string[] = [];
        const pending: string[] = [];
        for (const namespace of NAMED_NAMESPACES) {
            const landed = scannedPaths.some(
                (path) => path === namespace || path.startsWith(`${namespace}.`),
            );
            (landed ? present : pending).push(namespace);
        }

        expect(present.length + pending.length).toBe(NAMED_NAMESPACES.length);
        // Nothing to assert about the split today — it moves as surfaces land —
        // but the split must be real: every "pending" namespace really is absent.
        for (const namespace of pending) {
            expect(scannedPaths.some((path) => path.startsWith(namespace))).toBe(false);
        }
    });

    it('has no English sign-on claim in any launcher string', () => {
        const offenders: string[] = [];

        for (const locale of allLocales) {
            for (const entry of launcherStrings(bundle(locale))) {
                if (ENGLISH_PATTERN.test(entry.value)) {
                    offenders.push(`${locale}:${entry.path} = ${JSON.stringify(entry.value)}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('has no reviewed translated sign-on claim in the locale it belongs to', () => {
        const offenders: string[] = [];
        const reviewed = rows.filter((row) => row.state === 'reviewed');

        for (const row of reviewed) {
            const locale = row.file.replace('.json', '');
            if (!allLocales.includes(locale)) continue;

            for (const entry of launcherStrings(bundle(locale))) {
                for (const phrase of row.phrases) {
                    if (entry.value.toLowerCase().includes(phrase.toLowerCase())) {
                        offenders.push(
                            `${locale}:${entry.path} contains ${JSON.stringify(phrase)}`,
                        );
                    }
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('is a real check: it flags a claim, and it permits what the spec does say', () => {
        // The control. Without this, a regex that matched nothing — or one so
        // broad that every sentence failed — would look the same from the
        // assertions above.
        expect(ENGLISH_PATTERN.test('Single sign-on across your apps')).toBe(true);
        expect(ENGLISH_PATTERN.test('Use SSO to open these')).toBe(true);
        expect(ENGLISH_PATTERN.test('one login for everything')).toBe(true);
        expect(ENGLISH_PATTERN.test('You are already signed in')).toBe(true);

        // Spec §6's two permitted sentences: a person MAY need to sign in, which
        // is true, and it never claims a shared session.
        expect(ENGLISH_PATTERN.test('Opens in a new tab. You may need to sign in.')).toBe(false);
        expect(ENGLISH_PATTERN.test('Sign in with Ever ID to see your apps here.')).toBe(false);
        expect(ENGLISH_PATTERN.test('App Launcher')).toBe(false);
    });
});
