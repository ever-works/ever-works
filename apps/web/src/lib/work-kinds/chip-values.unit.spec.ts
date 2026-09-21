import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ALL_NEW_CHIP_VALUES as VIA_NEW_INDEX } from '@/components/new';
import {
    ALL_NEW_CHIP_VALUES,
    ALL_WORK_KIND_CHIP_VALUES,
    CHIP_ORDER,
    WORK_KIND_ORDER,
} from './chip-values';

/**
 * Importing a chip component loads its whole runtime graph, and under vitest
 * two of those edges cannot resolve: `next-intl`'s navigation chunk imports
 * `next/navigation`, and `next-intl` / `sonner` are browser-facing. The
 * existing component spec (`components/new/NewPageClient.unit.spec.tsx`) mocks
 * the same three, so this spec does too — the assertions below are about the
 * ARRAY BINDINGS the modules export, not about their internals.
 */
vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    // `@/components/ui/button` dereferences `Link` at MODULE LOAD, so the mock
    // must provide it even though nothing here renders a link.
    Link: (props: { href?: string; children?: ReactNode }) =>
        createElement('a', { href: props.href }, props.children),
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

/**
 * `./new-work-client` cannot be named by a literal import specifier from here:
 * its route segment is `[locale]/(dashboard)`, and the `[` in a specifier is a
 * glob metacharacter to Vite's import-analysis, which refuses to resolve it
 * ("Failed to resolve import", measured). A `**` glob reaches the same file
 * without putting a bracket in the pattern, and the matched path is asserted to
 * be exactly the one module so the glob cannot silently stop matching.
 */
interface WorksClientModule {
    ALL_WORK_KIND_CHIP_VALUES: ReadonlyArray<string>;
}

const worksClientModules = import.meta.glob('../../app/**/works/new/new-work-client.tsx') as Record<
    string,
    () => Promise<WorksClientModule>
>;

/**
 * The chip catalogs moved OUT of two `'use client'` modules and into
 * `./chip-values`, because the two server pages imported a plain value across a
 * client boundary and received a client reference instead of the array — which
 * threw `TypeError: a.filter is not a function` out of the server render and
 * 500'd `/new` and `/works/new`.
 *
 * Three things are pinned here, because a move like this fails in three
 * different ways:
 *
 *  1. **Contents and order.** If a member is dropped in the move — the
 *     realistic accident, and an invisible one, since every remaining chip still
 *     renders — this spec reddens.
 *  2. **The original export sites.** `@/components/new` and
 *     `./new-work-client` must still export the same names, bound to the SAME
 *     array instance. Dropping the re-export would break every existing
 *     consumer without touching a test that only reads the new module.
 *  3. **The client boundary.** The new module must carry no `'use client'`
 *     directive (or it has moved the bug rather than fixed it) and no
 *     `server-only` marker (or the two client components cannot import it),
 *     while both old modules must STILL be client modules, and both server
 *     pages must read the arrays from the new module.
 *
 * ⚠️ What (3) does and does not prove. It is a source-level assertion: it proves
 * the array is now declared in a module with no client directive, that the
 * server pages import it from there, and that the old client modules still
 * declare the directive — i.e. the *shape* that produced the client reference is
 * gone. It does NOT execute a React Server Component render, so it cannot prove
 * Next.js' bundler emits the real array rather than a reference on the server
 * side. Only the Playwright lanes render these pages.
 */

/** The source of a file next to this spec (or a relative path to one). */
function source(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

/**
 * The first line of actual code, skipping blanks and comments — the position a
 * `'use client'` DIRECTIVE must occupy. Checking whether the file merely
 * CONTAINS the string would false-positive on any file that mentions the
 * directive in a comment (this one and `chip-values.ts` both do).
 */
function firstCodeLine(text: string): string {
    const line = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(
            (l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'),
        );
    return line ?? '';
}

const hasUseClientDirective = (text: string) =>
    firstCodeLine(text) === "'use client';" || firstCodeLine(text) === '"use client";';

// Relative to THIS file (a URL base replaces the last path segment, so `..`
// lands on `src/lib`, not on `src`).
const NEW_PAGE = '../../app/[locale]/(dashboard)/new/page.tsx';
const WORK_KINDS_PAGE = '../../app/[locale]/(dashboard)/works/new/page.tsx';
const NEW_CLIENT = '../../components/new/NewPageClient.tsx';
const WORKS_NEW_CLIENT = '../../app/[locale]/(dashboard)/works/new/new-work-client.tsx';
/** The Dashboard composer — a THIRD server page reading the same catalog. */
const HOME_PAGE = '../../app/[locale]/(dashboard)/(home)/page.tsx';

describe('chip-values — the server-safe home of the chip catalogs', () => {
    describe('the `/new` chip catalog', () => {
        it('is exactly the live chips in render order, with `store` appended', () => {
            expect([...CHIP_ORDER]).toEqual([
                'mission',
                'idea',
                'agent',
                'task',
                'website',
                'landing-page',
                'blog',
                'directory',
                'awesome-repo',
                'repo',
                'company',
            ]);

            expect([...ALL_NEW_CHIP_VALUES]).toEqual([...CHIP_ORDER, 'store']);
        });

        it('is a real Array — the thing the server page could not get across the client boundary', () => {
            expect(Array.isArray(ALL_NEW_CHIP_VALUES)).toBe(true);
            expect(Array.isArray(CHIP_ORDER)).toBe(true);
        });
    });

    describe('the `/works/new` work-kind catalog', () => {
        it('is exactly the live kinds in render order, with `store` then `company` appended', () => {
            expect([...WORK_KIND_ORDER]).toEqual([
                'website',
                'landing-page',
                'blog',
                'directory',
                'awesome-repo',
                'repo',
            ]);

            expect([...ALL_WORK_KIND_CHIP_VALUES]).toEqual([
                ...WORK_KIND_ORDER,
                'store',
                'company',
            ]);
        });

        it('keeps `store` and `company` — the two members a "move" is most likely to lose', () => {
            expect([...ALL_WORK_KIND_CHIP_VALUES]).toContain('store');
            expect([...ALL_WORK_KIND_CHIP_VALUES]).toContain('company');
            expect([...ALL_NEW_CHIP_VALUES]).toContain('store');
        });

        it('is a real Array', () => {
            expect(Array.isArray(ALL_WORK_KIND_CHIP_VALUES)).toBe(true);
        });
    });

    describe('the client modules still export the same names, bound to the same array', () => {
        it('`@/components/new` re-exports `ALL_NEW_CHIP_VALUES`', () => {
            expect(Array.isArray(VIA_NEW_INDEX)).toBe(true);
            expect([...VIA_NEW_INDEX]).toEqual([...ALL_NEW_CHIP_VALUES]);
            // Identity, not just equality: a SECOND definition would pass the
            // equality check and then drift silently.
            expect(VIA_NEW_INDEX).toBe(ALL_NEW_CHIP_VALUES);
        });

        it('`./new-work-client` re-exports `ALL_WORK_KIND_CHIP_VALUES`', async () => {
            const entries = Object.entries(worksClientModules);
            expect(entries, 'the glob must still match exactly one client module').toHaveLength(1);
            expect(
                entries[0][0].endsWith('app/[locale]/(dashboard)/works/new/new-work-client.tsx'),
            ).toBe(true);

            const viaClient = (await entries[0][1]()).ALL_WORK_KIND_CHIP_VALUES;

            expect(Array.isArray(viaClient)).toBe(true);
            expect([...viaClient]).toEqual([...ALL_WORK_KIND_CHIP_VALUES]);
            expect(viaClient).toBe(ALL_WORK_KIND_CHIP_VALUES);
        });
    });

    describe('the client boundary the crash came from', () => {
        it('`chip-values.ts` is NOT a client module and NOT server-only', () => {
            const text = source('./chip-values.ts');

            expect(hasUseClientDirective(text)).toBe(false);
            expect(text).not.toContain("from 'server-only'");
        });

        it('both modules the arrays moved OUT of are still client modules', () => {
            expect(hasUseClientDirective(source(NEW_CLIENT))).toBe(true);
            expect(hasUseClientDirective(source(WORKS_NEW_CLIENT))).toBe(true);
        });

        it('the Dashboard composer imports the catalog from here too, not from the client barrel', () => {
            // Added 2026-09-22. That page took `ALL_NEW_CHIP_VALUES` from
            // `@/components/new`, which re-exports it from `NewPageClient` — a
            // `'use client'` module — so the server render received a client
            // reference and `getDisabledWorkKinds`'s `values.filter(…)` threw.
            // The same 500 this module was extracted to end, on a third page.
            // `pnpm run boundary:barrels` caught it; this pins it.
            const homePage = source(HOME_PAGE);

            expect(homePage).toContain("from '@/lib/work-kinds/chip-values'");
            expect(homePage).not.toMatch(
                /import\s*\{[^}]*ALL_NEW_CHIP_VALUES[^}]*\}\s*from\s*'@\/components\/new'/,
            );
        });

        it('both server pages import the arrays from `@/lib/work-kinds/chip-values`', () => {
            const newPage = source(NEW_PAGE);
            expect(newPage).toContain("from '@/lib/work-kinds/chip-values'");
            expect(newPage).toContain('ALL_NEW_CHIP_VALUES');
            // The old, crashing import shape: a plain VALUE imported from the
            // client barrel. (`ChipType` is a type and is erased at build time,
            // so only the value import is asserted against.)
            expect(newPage).not.toMatch(
                /import\s*\{[^}]*\bALL_NEW_CHIP_VALUES\b[^}]*\}\s*from\s*'@\/components\/new'/,
            );

            const worksPage = source(WORK_KINDS_PAGE);
            expect(worksPage).toContain("from '@/lib/work-kinds/chip-values'");
            expect(worksPage).toContain('ALL_WORK_KIND_CHIP_VALUES');
            expect(worksPage).not.toMatch(
                /import\s*\{[^}]*\bALL_WORK_KIND_CHIP_VALUES\b[^}]*\}\s*from\s*'\.\/new-work-client'/,
            );
        });

        it('declares each array exactly once in the tree', () => {
            // The point of the move is ONE definition per array: the two old
            // modules must import-and-re-export, never restate.
            for (const [file, name] of [
                [NEW_CLIENT, 'ALL_NEW_CHIP_VALUES'],
                [WORKS_NEW_CLIENT, 'ALL_WORK_KIND_CHIP_VALUES'],
            ] as const) {
                expect(source(file), `${name} must not be redeclared in ${file}`).not.toMatch(
                    new RegExp(`(export\\s+)?const\\s+${name}\\b`),
                );
            }
        });
    });
});
