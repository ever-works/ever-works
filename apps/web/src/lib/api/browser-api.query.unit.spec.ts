// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { withWorkspaceScopeQuery } from './browser-api';

/**
 * The client half of the query-string scope carrier. A BFF route reached by
 * navigation only ever sees a selector if the URL carries one, so every
 * `<a href download>` / `<img src>` pointing at such a route has to be built
 * through this — and it has to re-derive from the VISIBLE tab path each time,
 * so a second tab on another Organization cannot leak its scope into a link.
 */
function scopeOf(href: string): string | null {
    return new URL(href, 'http://web.example').searchParams.get('scope');
}

describe('withWorkspaceScopeQuery', () => {
    beforeEach(() => {
        window.history.pushState({}, '', '/org/ever/memory');
    });

    it('appends the Organization selector derived from the visible tab path', () => {
        const href = withWorkspaceScopeQuery('/api/memory/files/abc/download');

        expect(scopeOf(href)).toBe('org:ever');
        expect(href.startsWith('/api/memory/files/abc/download?')).toBe(true);
    });

    it('appends the personal selector on a personal-scope page', () => {
        window.history.pushState({}, '', '/dashboard');

        expect(scopeOf(withWorkspaceScopeQuery('/api/credits/usage/export'))).toBe('personal');
    });

    it('re-derives per call, so navigating the tab changes the next link', () => {
        const before = withWorkspaceScopeQuery('/api/x');
        window.history.pushState({}, '', '/org/yo/memory');
        const after = withWorkspaceScopeQuery('/api/x');

        expect(scopeOf(before)).toBe('org:ever');
        expect(scopeOf(after)).toBe('org:yo');
    });

    it('preserves an existing query string and appends rather than replacing it', () => {
        const href = withWorkspaceScopeQuery(
            '/api/credits/usage/export?from=2026-08-01&to=2026-09-01',
        );

        const url = new URL(href, 'http://web.example');
        expect(url.searchParams.get('from')).toBe('2026-08-01');
        expect(url.searchParams.get('to')).toBe('2026-09-01');
        expect(url.searchParams.get('scope')).toBe('org:ever');
    });

    it('overwrites a stale scope param instead of producing two', () => {
        const href = withWorkspaceScopeQuery('/api/x?scope=org:stale');

        const url = new URL(href, 'http://web.example');
        expect(url.searchParams.getAll('scope')).toEqual(['org:ever']);
    });

    it('keeps the hash', () => {
        expect(withWorkspaceScopeQuery('/api/x#frag').endsWith('#frag')).toBe(true);
    });

    it('returns a same-origin RELATIVE url, never an absolute one', () => {
        const href = withWorkspaceScopeQuery('/api/x');

        expect(href.startsWith('/')).toBe(true);
        expect(href).not.toContain('://');
    });

    it('refuses a cross-origin href rather than silently stripping the origin', () => {
        expect(() => withWorkspaceScopeQuery('http://evil.example/api/x')).toThrow('same-origin');
    });
});
