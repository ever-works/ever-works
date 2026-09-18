import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * APW-11 T19 — cross-locale completeness (ACC-11-31).
 *
 * Three claims, each one a way the launcher can ship a hole:
 *
 *  1. **every key resolves in every bundle.** A missing leaf is not a build
 *     error in Next: `next-intl` falls back to English for a *key*, but the
 *     fallback collapses when an intermediate object is missing, so a whole
 *     absent group renders raw keys to a member. The group is asserted complete
 *     in all 21 bundles rather than only in `en.json`.
 *  2. **no leaf name contains a dot.** `t('a.b')` is a PATH, not a key, so a key
 *     literally named `a.b` is unreachable — the mistake is silent and the copy
 *     simply never appears.
 *  3. **every `t('…')` the components call exists.** A component asking for a key
 *     nobody added fails at RUNTIME, in the browser, for one locale. Reading the
 *     source is the only way to catch it before a member does, and the scan
 *     asserts it really found keys (a vacuity check) and that it looked at the
 *     component it was written for.
 *
 * Plan §8 is the copy of record; the P2 `signIn*` keys landed with P1 because the
 * block is meant to be complete (T27 renders them), so they are asserted too.
 */

const MESSAGES_DIR = join(__dirname, '..', '..', '..', '..', 'messages');
const COMPONENTS_DIR = join(__dirname, '..', '..', '..', 'components', 'app-launcher');

/** plan.md §8's `dashboard.appLauncher.*` block — the whole landed set. */
const LAUNCHER_KEYS = [
    'controlLabel',
    'controlTooltip',
    'panelTitle',
    'sectionPinned',
    'sectionPlatforms',
    'sectionWorks',
    'chipCurrent',
    'chipBeta',
    'chipDeploying',
    'chipLastDeployFailed',
    'viewAll',
    'footerHelper',
    'manageLink',
    'emptyWorks',
    'emptyWorksCreateApp',
    'emptyWorksGoToWorks',
    'allHidden',
    'catalogError',
    'worksError',
    'retry',
    'controlUnavailable',
    'emptyActionFailed',
    'signInPrompt',
    'signIn',
] as const;

/** Every locale bundle the app ships (README §7 rule 11: all 21 carry the same keys). */
function localeFiles(): string[] {
    return readdirSync(MESSAGES_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort();
}

function bundle(file: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(MESSAGES_DIR, file), 'utf8')) as Record<string, unknown>;
}

/** Every leaf path in an object, `a.b.c` form. */
function leafPaths(node: unknown, prefix = ''): string[] {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return [prefix];
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        leafPaths(value, prefix ? `${prefix}.${key}` : key),
    );
}

describe('the App Launcher message keys (APW-11 T19, ACC-11-31)', () => {
    it('carries every launcher key in all 21 locale bundles, each a non-empty string', () => {
        const files = localeFiles();
        expect(files).toHaveLength(21);

        for (const file of files) {
            const block = (bundle(file).dashboard as Record<string, unknown> | undefined)
                ?.appLauncher as Record<string, unknown> | undefined;
            expect(block, `${file}: dashboard.appLauncher`).toBeDefined();
            for (const key of LAUNCHER_KEYS) {
                expect(typeof block?.[key], `${file}: ${key}`).toBe('string');
                expect((block?.[key] as string).trim().length, `${file}: ${key}`).toBeGreaterThan(
                    0,
                );
            }
        }
    });

    it('never names a leaf with a literal dot, which would be unreachable as a message path', () => {
        for (const file of localeFiles()) {
            const block = (bundle(file).dashboard as Record<string, unknown>).appLauncher as Record<
                string,
                unknown
            >;
            for (const leaf of leafPaths(block)) {
                expect(leaf, `${file}: ${leaf}`).not.toContain('.');
            }
        }
    });

    it('resolves every `t(…)` the launcher components call, in en.json', () => {
        const en = bundle('en.json');
        /** Resolve a dot path against en.json; `undefined` when it is not a string. */
        const resolve = (path: string): unknown =>
            path.split('.').reduce<unknown>((node, segment) => {
                if (node && typeof node === 'object') {
                    return (node as Record<string, unknown>)[segment];
                }
                return undefined;
            }, en);

        // The launcher components that render copy. `AppLauncherProvider.tsx` is
        // deliberately absent: it is the context that lets the palette open the
        // element and renders no strings at all, so requiring a namespace of it
        // would be requiring copy it should not have.
        //
        // ⚠️ The settings editor lives in `components/settings`, NOT beside the
        // panel, which the first version of this scan missed entirely — it looked
        // in one directory. It renders copy from TWO namespaces (its own
        // `dashboard.settings.appLauncher` and, for the strings it reuses from the
        // panel, `dashboard.appLauncher`), which is why the scan below maps each
        // translator VARIABLE to the namespace it was created from instead of
        // assuming the file's first namespace governs every `t('…')` in it. A
        // per-file namespace would have reported a false failure on exactly the
        // file with the most keys.
        const files = [
            join(COMPONENTS_DIR, 'AppLauncherButton.tsx'),
            join(COMPONENTS_DIR, 'AppLauncherProvider.tsx'),
            join(__dirname, '..', '..', '..', 'components', 'settings', 'AppLauncherSettings.tsx'),
            join(
                __dirname,
                '..',
                '..',
                '..',
                'components',
                'works',
                'detail',
                'settings',
                'AppLauncherExposureSetting.tsx',
            ),
            join(
                __dirname,
                '..',
                '..',
                '..',
                'components',
                'works',
                'detail',
                'overview',
                'AppLauncherExposureCard.tsx',
            ),
        ];
        let checked = 0;
        let scanned = 0;
        /** The files that actually rendered copy — asserted below, so the scan cannot shrink silently. */
        const contributing = new Set<string>();

        for (const path of files) {
            const name = path.split(/[\\/]/).pop() ?? path;
            // Absent files are skipped, but the file the whole feature hangs on is not.
            if (!existsSync(path)) {
                if (name === 'AppLauncherButton.tsx') {
                    throw new Error('AppLauncherButton.tsx is missing — the scan proves nothing');
                }
                continue;
            }
            scanned += 1;

            const source = readFileSync(path, 'utf8');
            // `const t = useTranslations('a.b')` (and any other variable name) →
            // the namespace that variable resolves against.
            const byVariable = new Map<string, string>();
            for (const match of source.matchAll(
                /const\s+([A-Za-z0-9_$]+)\s*=\s*useTranslations\(\s*'([^']+)'\s*\)/g,
            )) {
                byVariable.set(match[1], match[2]);
            }
            // A file with no translator renders no copy — the provider is exactly
            // that, and requiring copy of it would be requiring copy it should not
            // have. Such a file is skipped, never counted as verified.
            if (byVariable.size === 0) continue;
            contributing.add(name);

            // Every `<var>('key')` call, resolved through its own namespace. A call
            // on something that is not a translator (a local helper) is ignored.
            let calls = 0;
            for (const match of source.matchAll(/\b([A-Za-z0-9_$]+)\(\s*'([A-Za-z0-9_]+)'/g)) {
                const namespace = byVariable.get(match[1]);
                if (!namespace) continue;
                calls += 1;
                const key = `${namespace}.${match[2]}`;
                expect(typeof resolve(key), `${name}: ${key}`).toBe('string');
            }
            expect(calls, `${name}: no translator calls found`).toBeGreaterThan(0);
            checked += calls;
        }

        // Vacuity guards: a scan that silently matched nothing — or that only ever
        // looked at one file — would pass every assertion above. The two that must
        // contribute are named, so deleting a `useTranslations` call from one of them
        // fails here instead of quietly shrinking the scan.
        expect(scanned, 'files present').toBeGreaterThanOrEqual(2);
        expect(contributing.has('AppLauncherButton.tsx'), 'the control contributed').toBe(true);
        expect(contributing.has('AppLauncherSettings.tsx'), 'the settings editor contributed').toBe(
            true,
        );
        expect(checked, 'translator calls resolved').toBeGreaterThan(40);
    });
});
