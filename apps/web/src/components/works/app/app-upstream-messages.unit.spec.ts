import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { APP_UPSTREAM_WARNING_CODES } from '@ever-works/contracts';

/**
 * APW-02 T35 — the Upstream copy, complete in all 21 locale bundles.
 *
 * ## Why this spec exists
 *
 * The Upstream tab landed with its keys in `messages/en.json` only, and
 * `next-intl` does not treat a missing message as a build error: it falls back
 * for a *leaf*, but an absent **intermediate object** collapses the whole
 * subtree, so `dashboard.workDetail.appUpstream` rendered as raw key paths for
 * every non-English locale. A missing translation is therefore invisible to
 * `tsc`, to the build and to the English e2e lane. This spec is where it fails.
 *
 * Five claims, each a way the block can ship a hole:
 *
 *  1. **every leaf resolves in every bundle.** The 52 leaves of the tree plus
 *     `dashboard.workDetail.upstream.tabName` and the three
 *     `dashboard.activity.filters.types.app*` labels are asserted present and
 *     non-empty in all 21 bundles, not only in `en.json`.
 *  2. **no leaf name contains a dot.** `t('a.b')` is a PATH, not a key, so a key
 *     literally named `a.b` is unreachable and the copy silently never appears
 *     (README §7 rule 11).
 *  3. **every warning code the card composes has copy.** `AppUpstreamWarnings`
 *     renders `t(\`warnings.${warning.code}\`)` — a key built at RUNTIME, which
 *     no source scan can follow. `APP_UPSTREAM_WARNING_CODES` is the closed set
 *     (FR-65), so pinning every member to a leaf is what keeps the two in step.
 *  4. **every message survives an ICU round trip, in every locale.** The plural
 *     messages are real ICU MessageFormat. A translated plural with a broken
 *     brace or a lost `#` raises `INVALID_MESSAGE` and next-intl then renders the
 *     key path instead of the sentence — the same fault class the Meetings guard
 *     pins (`components/meetings/meetings-messages.unit.spec.ts`).
 *  5. **every placeholder the English copy passes survives translation.** A
 *     dropped `{repo}` is not a syntax error: the sentence simply renders
 *     without the repository name. The invariant asserted is the one the repo's
 *     own translator enforces before it writes a bundle
 *     (`scripts/translate-messages.mjs`, `validateMessageVariables`).
 *
 * A source scan of the three components adds the other direction — a `t('…')`
 * the components call but nobody translated (the scan is the APW-11 T19
 * `app-launcher-messages.unit.spec.ts` pattern, plus its vacuity guards).
 *
 * `en.json` is the copy of record (plan §8, `plan.md:847-870`; spec §6.1-6.2,
 * `spec.md:478-536`), so every assertion is derived from it rather than from a
 * second hand-kept list of key names.
 */

// Vitest's root is `apps/web` (see vitest.config.ts), so the bundle directory
// resolves off the cwd rather than import.meta.url — which is not a file: URL
// under the Vite transform.
const MESSAGES_DIR = resolve(process.cwd(), 'messages');
const APP_DIR = __dirname;

/** Every locale code the app ships a bundle for (README §7 rule 11: all 21 carry the same keys). */
function localeFiles(): string[] {
    return readdirSync(MESSAGES_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace('.json', ''))
        .sort();
}

type Tree = { [key: string]: string | Tree };

function bundle(locale: string): { dashboard: Tree } {
    return JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as {
        dashboard: Tree;
    };
}

/** Resolve a dot path against a bundle; `undefined` when it is not a string. */
function leafAt(root: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((node, segment) => {
        if (node && typeof node === 'object') {
            return (node as Record<string, unknown>)[segment];
        }
        return undefined;
    }, root);
}

/**
 * {@link leafAt} narrowed to a subtree. `Tree` indexing yields `string | Tree`,
 * so reaching a nested object needs this rather than a chain of property reads.
 */
function treeAt(root: unknown, path: string): Tree {
    const node = leafAt(root, path);
    return (node && typeof node === 'object' ? node : {}) as Tree;
}

/** Every leaf path in a subtree, `a.b.c` form. */
function leafPaths(node: unknown, prefix = ''): string[] {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return [prefix];
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        leafPaths(value, prefix ? `${prefix}.${key}` : key),
    );
}

/** Flatten a subtree into `leaf -> message`. */
function leaves(node: unknown, prefix = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries((node ?? {}) as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') Object.assign(out, leaves(value, path));
        else out[path] = value as string;
    }
    return out;
}

/**
 * Every object key anywhere in a subtree.
 *
 * The dot rule is about the KEY, not the path: `readiness.preparing` is a
 * perfectly good path made of two good keys, while a key literally named
 * `readiness.preparing` would be unreachable — `t('a.b')` is a path lookup, so
 * the message would silently never render. Asserting on paths instead of keys
 * would fail on every nested leaf, which is not the fault being guarded.
 */
function keyNames(node: unknown): string[] {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => [
        key,
        ...keyNames(value),
    ]);
}

const EN = bundle('en');
const EN_APP_UPSTREAM = treeAt(EN, 'dashboard.workDetail.appUpstream');
const APP_UPSTREAM_LEAVES = leafPaths(EN_APP_UPSTREAM).sort();

/** The three Activity-stream labels the filter list renders (plan §8, `plan.md:867`). */
const ACTIVITY_TYPE_LEAVES = ['appFork', 'appActions', 'appUpstream'] as const;

/**
 * The readiness row's five leaves (spec §6.1, `spec.md:496`).
 *
 * Pinned as literals rather than derived, because it is the mapping in
 * `AppUpstreamCard.tsx`'s `UPSTREAM_READINESS_COPY_KEYS` — the one place a
 * renamed leaf would compile and silently render the wrong state's word.
 */
const READINESS_LEAVES = [
    'readiness.preparing',
    'readiness.ready',
    'readiness.waitingForSetupPr',
    'readiness.timedOut',
    'readiness.failed',
    'readiness.tryAgain',
] as const;

/** The components that render this copy. */
const COMPONENT_FILES = [
    'AppUpstreamCard.tsx',
    'AppUpstreamWarnings.tsx',
    'UpstreamDivergenceBadge.tsx',
] as const;

const NAMESPACE = 'dashboard.workDetail.appUpstream';

/**
 * The same subtree relative to `dashboard`, which is the base the per-locale
 * lookups start from (`bundle(locale).dashboard`). Kept separate from
 * {@link NAMESPACE} so a lookup can never be rooted twice.
 */
const APP_UPSTREAM_PATH = 'workDetail.appUpstream';

/**
 * The ICU argument names of a message: `{repo}` and the `count` of
 * `{count, plural, …}`.
 *
 * Deliberately not a full ICU parser — claim 4 already proves the message
 * PARSES, so this only has to find the argument names, and a name is always
 * `[A-Za-z0-9_]+` followed by `}` or `,`. The plural *options* are skipped
 * naturally: in `{1 commit behind upstream}` the `1` is followed by a space and
 * then a letter, and `{# commits}` does not start with a name at all.
 */
function argumentNames(message: string): string[] {
    const names = new Set<string>();
    for (const match of message.matchAll(/\{\s*([A-Za-z0-9_]+)\s*(?=[},])/g)) {
        names.add(match[1]);
    }
    return [...names].sort();
}

const locales = localeFiles();

describe('Upstream messages — the whole block, in all 21 bundles (APW-02 T35)', () => {
    it('covers every locale bundle the app ships', () => {
        // A guard on the guard: if locales stop being discovered, every
        // per-locale assertion below would vacuously pass.
        expect(locales).toHaveLength(21);
        expect(locales).toContain('en');
    });

    it('has a non-trivial block to assert, so the scan cannot silently shrink', () => {
        // Vacuity guard: the English tree is the shape every other locale is
        // held to. 52 leaves under the tree, plus the tab name and the three
        // Activity labels, is the landed block.
        expect(APP_UPSTREAM_LEAVES).toHaveLength(52);
        expect(APP_UPSTREAM_LEAVES).toContain('title');
        expect(APP_UPSTREAM_LEAVES).toContain('warnings.upstreamArchived');
        expect(APP_UPSTREAM_LEAVES).toContain('readiness.waitingForSetupPr');
        expect(treeAt(EN, 'dashboard.workDetail.upstream')).toEqual({ tabName: 'Upstream' });
    });

    for (const locale of locales) {
        it(`${locale} — carries every Upstream leaf as a non-empty string`, () => {
            const tree = bundle(locale).dashboard;
            const missing: string[] = [];

            for (const leaf of APP_UPSTREAM_LEAVES) {
                const value = leafAt(tree, `${APP_UPSTREAM_PATH}.${leaf}`);
                if (typeof value !== 'string' || value.trim().length === 0) {
                    missing.push(`${NAMESPACE}.${leaf}`);
                }
            }

            for (const leaf of [...READINESS_LEAVES, 'title']) {
                const value = leafAt(tree, `${APP_UPSTREAM_PATH}.${leaf}`);
                if (typeof value !== 'string' || value.trim().length === 0) {
                    missing.push(`${NAMESPACE}.${leaf}`);
                }
            }

            for (const leaf of ACTIVITY_TYPE_LEAVES) {
                const path = `activity.filters.types.${leaf}`;
                const value = leafAt(tree, path);
                if (typeof value !== 'string' || value.trim().length === 0) {
                    missing.push(`dashboard.${path}`);
                }
            }

            const tabName = leafAt(tree, 'workDetail.upstream.tabName');
            if (typeof tabName !== 'string' || tabName.trim().length === 0) {
                missing.push('dashboard.workDetail.upstream.tabName');
            }

            expect(missing).toEqual([]);
        });
    }

    it('never names a leaf with a literal dot, which would be unreachable as a message path', () => {
        for (const locale of locales) {
            const tree = bundle(locale).dashboard;
            const block = leafAt(tree, APP_UPSTREAM_PATH);
            expect(block, `${locale}: ${NAMESPACE}`).toBeTruthy();

            for (const key of keyNames(block)) {
                expect(key, `${locale}: ${NAMESPACE}.${key}`).not.toContain('.');
            }

            const types = leafAt(tree, 'activity.filters.types') as Tree;
            for (const key of keyNames(types)) {
                expect(key, `${locale}: dashboard.activity.filters.types.${key}`).not.toContain(
                    '.',
                );
            }
        }
    });

    it('resolves every warning code the card composes at runtime, in all 21 bundles', () => {
        // `AppUpstreamWarnings.tsx` renders `t(\`warnings.${warning.code}\`)`, so
        // this is the only place the composed key is checked before a member
        // sees a raw key path.
        expect(APP_UPSTREAM_WARNING_CODES.length).toBeGreaterThanOrEqual(12);

        for (const locale of locales) {
            const tree = bundle(locale).dashboard;
            for (const code of APP_UPSTREAM_WARNING_CODES) {
                const value = leafAt(tree, `${APP_UPSTREAM_PATH}.warnings.${code}`);
                expect(typeof value, `${locale}: ${NAMESPACE}.warnings.${code}`).toBe('string');
                expect((value as string).trim().length, `${locale}: ${code}`).toBeGreaterThan(0);
            }
        }
    });

    it('resolves every `t(…)` the card, warnings list and badge call', () => {
        let checked = 0;
        const contributing = new Set<string>();

        for (const file of COMPONENT_FILES) {
            const path = join(APP_DIR, file);
            // Absent files are skipped, but the component the feature hangs on is not.
            if (!existsSync(path)) {
                if (file === 'AppUpstreamCard.tsx') {
                    throw new Error('AppUpstreamCard.tsx is missing — the scan proves nothing');
                }
                continue;
            }

            const source = readFileSync(path, 'utf8');
            // `const t = useTranslations('dashboard.workDetail.appUpstream')` — a
            // file with no translator renders none of this copy and is not counted.
            const namespaces = [...source.matchAll(/useTranslations\(\s*'([^']+)'\s*\)/g)].map(
                (match) => match[1],
            );
            if (namespaces.length === 0) continue;
            contributing.add(file);

            for (const namespace of namespaces) {
                for (const match of source.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) {
                    checked += 1;
                    const value = leafAt(EN, `${namespace}.${match[1]}`);
                    expect(typeof value, `${file}: ${namespace}.${match[1]}`).toBe('string');
                }
            }

            // The literal leaves inside `UPSTREAM_READINESS_COPY_KEYS` — the map
            // is `readiness.<state>`, so a renamed leaf there is a rename of the
            // key this spec holds every locale to.
            for (const match of source.matchAll(/'(readiness\.[A-Za-z0-9]+)'/g)) {
                checked += 1;
                expect(typeof leafAt(EN, `${NAMESPACE}.${match[1]}`), `${file}: ${match[1]}`).toBe(
                    'string',
                );
            }
        }

        // Vacuity guards: a scan that matched nothing, or that only ever looked
        // at one file, would pass every assertion above.
        expect(contributing.has('AppUpstreamCard.tsx'), 'the card contributed').toBe(true);
        expect(contributing.has('AppUpstreamWarnings.tsx'), 'the warnings list contributed').toBe(
            true,
        );
        expect(contributing.has('UpstreamDivergenceBadge.tsx'), 'the badge contributed').toBe(true);
        expect(checked, 'translator calls resolved').toBeGreaterThanOrEqual(25);
    });

    for (const locale of locales) {
        it(`${locale} — every Upstream message parses as ICU and keeps its placeholders`, () => {
            const messages = bundle(locale);
            const invalid: string[] = [];
            const drift: string[] = [];

            for (const [leaf, english] of Object.entries(leaves(EN_APP_UPSTREAM))) {
                const translated = leafAt(messages.dashboard, `${APP_UPSTREAM_PATH}.${leaf}`);
                expect(typeof translated, `${locale}: ${NAMESPACE}.${leaf}`).toBe('string');

                const t = createTranslator({
                    locale,
                    messages: messages as Record<string, unknown>,
                    namespace: NAMESPACE,
                    onError: (error) => {
                        const text = String((error as { message?: string })?.message ?? error);
                        if (text.includes('INVALID_MESSAGE')) {
                            invalid.push(`${NAMESPACE}.${leaf}: ${text}`);
                        }
                    },
                });

                // next-intl types `t` against the literal key union of en.json;
                // this spec walks the keys it discovered at runtime.
                (t as unknown as (k: string, v?: Record<string, unknown>) => string)(leaf, {
                    count: 2,
                    ahead: 1,
                    behind: 2,
                    ago: '6 minutes ago',
                    when: 'Mon 06:03 UTC',
                    time: '07:00',
                    spdx: 'MIT',
                    repo: 'acme/tasks-app',
                    old: 'main',
                    new: 'trunk',
                    permission: 'Contents',
                    upstream: 'acme/tasks-app',
                    reason: 'conflict',
                });

                // A translated placeholder set must EQUAL the English one: a
                // dropped `{repo}` renders a sentence with a hole and no error.
                if (typeof translated === 'string') {
                    const expected = argumentNames(english);
                    const actual = argumentNames(translated);
                    if (expected.join(',') !== actual.join(',')) {
                        drift.push(
                            `${NAMESPACE}.${leaf}: expected [${expected.join(', ')}] got [${actual.join(', ')}]`,
                        );
                    }
                }
            }

            expect(invalid, `${locale} has invalid ICU messages`).toEqual([]);
            expect(drift, `${locale} changed the placeholder set`).toEqual([]);
        });
    }

    it('keeps the four plural messages plural, with their categories intact', () => {
        // The four `{count, plural, …}` messages of spec §6.1. A translation that
        // flattened one to a plain sentence would still parse and still pass the
        // placeholder check — this is what pins the plural.
        const pluralLeaves = [
            'behind',
            'ahead',
            'resultFastForwarded',
            'workflowsDisabled',
        ] as const;

        for (const locale of locales) {
            const messages = bundle(locale);
            for (const leaf of pluralLeaves) {
                const english = String(leafAt(EN.dashboard, `${APP_UPSTREAM_PATH}.${leaf}`));
                const translated = leafAt(messages.dashboard, `${APP_UPSTREAM_PATH}.${leaf}`);

                expect(english, `en: ${leaf}`).toContain('plural');
                expect(
                    translated,
                    `${locale}: ${NAMESPACE}.${leaf} is no longer a plural`,
                ).toContain('plural');
                // `=1` and `other` are the categories the source uses, and the
                // repo's translator is told to keep categories intact.
                expect(english, `en: ${leaf}`).toContain('=1 {');
                expect(translated, `${locale}: ${NAMESPACE}.${leaf} lost a category`).toContain(
                    '=1 {',
                );
                expect(translated, `${locale}: ${NAMESPACE}.${leaf} lost a category`).toContain(
                    'other {',
                );
                // `#` is the formatted count inside `other`; without it the
                // sentence loses its number.
                expect(translated, `${locale}: ${NAMESPACE}.${leaf} lost its #`).toContain('#');
            }
        }
    });

    it('keeps the two product names the platform never localises', () => {
        // `GitHub` and `Ever Works` are product names. A translation that
        // transliterated either would break the App-access row's meaning.
        // Only the leaves that NAME them are asserted, so ordinary copy is free.
        const english = leaves(EN_APP_UPSTREAM);

        for (const locale of locales) {
            const messages = bundle(locale);
            for (const leaf of ['warnings.appPermissionMissing']) {
                expect(english[leaf], `en: ${leaf}`).toContain('Ever Works');
                expect(
                    String(leafAt(messages.dashboard, `${APP_UPSTREAM_PATH}.${leaf}`)),
                    `${locale}: ${NAMESPACE}.${leaf}`,
                ).toContain('Ever Works');
            }
            for (const leaf of [
                'warnings.forkMissing',
                'warnings.privateCopyMissing',
                'warnings.rateLimited',
                'warnings.workflowsGated',
            ]) {
                expect(english[leaf], `en: ${leaf}`).toContain('GitHub');
                expect(
                    String(leafAt(messages.dashboard, `${APP_UPSTREAM_PATH}.${leaf}`)),
                    `${locale}: ${NAMESPACE}.${leaf}`,
                ).toContain('GitHub');
            }
        }
    });
});
