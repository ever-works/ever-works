import { describe, expect, it } from 'vitest';
import { WORKSPACE_SCOPE_QUERY_PARAM, withWorkspaceScopeQuery } from './workspace-scope';

const ORG = { kind: 'organization', slug: 'ever' } as const;
const PERSONAL = { kind: 'personal' } as const;

function scopeOf(href: string): string | null {
    return new URL(href, 'http://n').searchParams.get(WORKSPACE_SCOPE_QUERY_PARAM);
}

/**
 * The client half of the query-string scope carrier. A BFF route reached by
 * navigation only ever sees a selector if the URL carries one, so every
 * `<a href download>` / `<img src>` pointing at such a route is built through
 * this. It is PURE — the scope comes from `useWorkspaceScope()` — so a client
 * component can call it during the server pass without touching `window`.
 */
describe('withWorkspaceScopeQuery', () => {
    it('appends the Organization selector', () => {
        const href = withWorkspaceScopeQuery('/api/memory/files/abc/download', ORG);

        expect(scopeOf(href)).toBe('org:ever');
        expect(href.startsWith('/api/memory/files/abc/download?')).toBe(true);
    });

    it('appends the personal selector', () => {
        expect(scopeOf(withWorkspaceScopeQuery('/api/credits/usage/export', PERSONAL))).toBe(
            'personal',
        );
    });

    it('preserves an existing query string and appends rather than replacing it', () => {
        const url = new URL(
            withWorkspaceScopeQuery('/api/credits/usage/export?period=2026-08&format=csv', ORG),
            'http://n',
        );

        expect(url.searchParams.get('period')).toBe('2026-08');
        expect(url.searchParams.get('format')).toBe('csv');
        expect(url.searchParams.get('scope')).toBe('org:ever');
    });

    it('overwrites a stale scope param instead of producing two', () => {
        const url = new URL(withWorkspaceScopeQuery('/api/x?scope=org:stale', ORG), 'http://n');

        expect(url.searchParams.getAll('scope')).toEqual(['org:ever']);
    });

    it('keeps the hash', () => {
        expect(withWorkspaceScopeQuery('/api/x#frag', ORG).endsWith('#frag')).toBe(true);
    });

    it('returns a same-origin RELATIVE url, never an absolute one', () => {
        const href = withWorkspaceScopeQuery('/api/x', ORG);

        expect(href.startsWith('/')).toBe(true);
        expect(href).not.toContain('://');
    });

    it.each(['http://evil.example/api/x', '//evil.example/api/x', 'api/x'])(
        'refuses %j rather than silently decorating a foreign or page-relative URL',
        (bad) => {
            expect(() => withWorkspaceScopeQuery(bad, ORG)).toThrow('same-origin');
        },
    );
});
