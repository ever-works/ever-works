import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { showUpstreamCardOnOverview } from './app-upstream-visibility';
import { showUpstreamCardOnOverview as reExported } from '@/components/works/app/AppUpstreamCard';

/**
 * The regression pin for the `/works/<id>` server-render crash.
 *
 * `showUpstreamCardOnOverview` is CALLED by a **server** component — the App Work
 * Overview, `app/[locale]/(dashboard)/works/[id]/page.tsx`, in its render body.
 * It used to be declared in `@/components/works/app/AppUpstreamCard`, which is a
 * `'use client'` module, so the server render received a **client reference**
 * instead of the function and threw
 * `Attempted to call showUpstreamCardOnOverview() from the server but … it is on
 * the client` (measured digest `2265010250`). Next.js answered the route with its
 * error boundary, so `/works/<id>` was broken for every Work — and because the
 * failure is request-time only, `next build` stayed green.
 *
 * This spec guards the three properties whose loss reintroduces the crash:
 *
 *  1. the predicate's module carries **no** `'use client'` directive (a server
 *     component importing it gets the real function);
 *  2. the client card module **re-exports the same function object** rather than
 *     declaring a second copy — one definition, two entry points;
 *  3. the Overview page imports the predicate from the server-safe module and
 *     **not** from the client module.
 *
 * The generic form of the rule — "no server component may import a value from a
 * `'use client'` module" — is enforced mechanically by
 * `apps/web/scripts/check-server-client-boundary.mjs`, which covers the whole
 * tree rather than this one site.
 */

/**
 * Resolve a path relative to THIS spec's directory.
 *
 * `import.meta.url` is not usable on its own: under vitest's `jsdom`
 * environment it can be an `http(s)://` URL, and `fileURLToPath` then throws
 * `The URL must be of scheme file`. The cwd is not usable on its own either —
 * it depends on where the runner was invoked. So try both, and fail loudly
 * rather than reading the wrong file (a wrong-but-existing read is what would
 * turn every assertion below into a vacuous pass).
 */
function specRelative(relative: string): string {
    const bases: string[] = [];
    if (import.meta.url.startsWith('file:')) {
        bases.push(path.dirname(fileURLToPath(import.meta.url)));
    }
    bases.push(process.cwd(), path.join(process.cwd(), 'apps', 'web'));

    for (const base of bases) {
        const candidate = path.resolve(base, relative);
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `Could not resolve "${relative}" from any of: ${bases.join(', ')} — the spec must run with ` +
            'the web package as its root (`pnpm test` in apps/web).',
    );
}

const BOUNDARY_MODULE = specRelative('./app-upstream-visibility.ts');
const CLIENT_CARD_MODULE = specRelative('../../components/works/app/AppUpstreamCard.tsx');
const OVERVIEW_PAGE = specRelative('../../app/[locale]/(dashboard)/works/[id]/page.tsx');

function read(file: string): string {
    return readFileSync(file, 'utf8');
}

/**
 * The first non-comment, non-blank statement, which is where a bundler reads the
 * client/server directive from. Comments cannot carry a directive, so a module
 * whose first statement is a comment is a server module until proven otherwise.
 *
 * The trailing semicolon is stripped: `'use client';` and `'use client'` are the
 * same directive, and a guard that only recognised the semicolon-less spelling
 * would pass with the directive present. (It did — a mutant that prepended
 * `'use client';` to the boundary module stayed GREEN until this normalisation
 * was added.)
 */
function firstStatement(source: string): string {
    const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const lines = withoutBlockComments
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('//'));

    return (lines[0] ?? '').replace(/;$/, '');
}

/** Every `import … from '<source>'` statement, as `{ clause, source }`. */
function importStatements(source: string): { clause: string; source: string }[] {
    const withoutLineComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const statements: { clause: string; source: string }[] = [];
    const pattern = /import\s+([\s\S]*?)\s+from\s+'([^']+)'/g;

    for (const match of withoutLineComments.matchAll(pattern)) {
        statements.push({ clause: match[1].replace(/\s+/g, ' ').trim(), source: match[2] });
    }

    return statements;
}

/**
 * The names an import clause binds, in source order — `{ a, b }` → `['a', 'b']`,
 * `X, { y }` → `['X', 'y']`, `* as ns` → `['* as ns']`. Used instead of matching
 * the whole clause so the assertion is about WHICH bindings cross the boundary,
 * not about how they were formatted.
 */
function boundNames(clause: string): string[] {
    return clause
        .replace(/[{}]/g, ' ')
        .split(',')
        .map((name) => name.replace(/\s+/g, ' ').trim())
        .filter((name) => name.length > 0);
}

describe('the Overview predicate’s module boundary (the /works/<id> crash)', () => {
    it('is a plain module: no `use client`, no `server-only`', () => {
        const directive = firstStatement(read(BOUNDARY_MODULE));

        expect(directive).not.toBe("'use client'");
        expect(directive).not.toBe('"use client"');
        expect(directive).not.toBe("'server-only'");
        expect(directive).not.toBe('"server-only"');
        // The normalised spelling, so neither the quoting nor the optional
        // semicolon can smuggle the directive past the four assertions above.
        expect(directive.replace(/^['"]|['"]$/g, '')).not.toBe('use client');
        expect(directive.replace(/^['"]|['"]$/g, '')).not.toBe('server-only');
        // Non-vacuous: the first statement is a real statement, not an empty read.
        expect(directive.length).toBeGreaterThan(0);
    });

    it('is reached through the client card module as the SAME function, not a copy', () => {
        // Identity, not just name: a second local declaration would be a different
        // object and would silently drift from the pin.
        expect(reExported).toBe(showUpstreamCardOnOverview);
    });

    it('is re-exported by the client card module (one definition, two entry points)', () => {
        const clause = importStatements(read(CLIENT_CARD_MODULE)).find(
            (statement) => statement.source === '@/lib/works/app-upstream-visibility',
        );

        expect(clause?.clause).toContain('showUpstreamCardOnOverview');
        expect(read(CLIENT_CARD_MODULE)).toContain('export { showUpstreamCardOnOverview }');
    });

    it('is imported by the Overview page from the boundary module, never from the client module', () => {
        const statements = importStatements(read(OVERVIEW_PAGE));

        const fromBoundary = statements.filter(
            (statement) => statement.source === '@/lib/works/app-upstream-visibility',
        );
        const fromClientCard = statements.filter(
            (statement) => statement.source === '@/components/works/app/AppUpstreamCard',
        );

        expect(fromBoundary.flatMap((statement) => boundNames(statement.clause))).toEqual([
            'showUpstreamCardOnOverview',
        ]);
        // The component may cross the boundary; a function CALLED on the server may not.
        expect(fromClientCard.flatMap((statement) => boundNames(statement.clause))).toEqual([
            'AppUpstreamCard',
        ]);
        expect(
            fromClientCard.some((statement) =>
                boundNames(statement.clause).includes('showUpstreamCardOnOverview'),
            ),
        ).toBe(false);
    });

    it('reads the real page it claims to pin', () => {
        // A guard against a renamed/moved file turning every assertion above into a
        // vacuous pass: the page must still call the predicate in its render body.
        const page = read(OVERVIEW_PAGE);

        expect(page).toContain('export default async function WorkOverviewPage');
        expect(page).toContain('showUpstreamCardOnOverview(upstreamState)');
    });
});
