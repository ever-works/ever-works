import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    applyBffWorkspaceScope,
    applyBffWorkspaceScopeFromNavigation,
    upstreamSearchWithoutScope,
    WORKSPACE_SCOPE_QUERY_PARAM,
} from './bff-scope';

/**
 * The query-string scope carrier, for routes a browser NAVIGATES to.
 *
 * `<a href download>`, `<img src>` and `<video src>` cannot send
 * `x-ever-workspace`, and Next middleware cannot add it because its matcher
 * excludes `/api`. Before this carrier existed, those routes ran in personal
 * scope by construction: org Memory originals 404'd on download, and the usage
 * CSV ignored the Organization the user was standing in.
 */
function request(opts: { query?: string; header?: string; referer?: string } = {}) {
    const headers = new Headers({ 'x-scope-slug': 'attacker-supplied-yo' });
    if (opts.header) headers.set('x-ever-workspace', opts.header);
    if (opts.referer) headers.set('referer', opts.referer);
    const qs = opts.query !== undefined ? `?${WORKSPACE_SCOPE_QUERY_PARAM}=${opts.query}` : '';
    return new Request(`http://web.example/api/memory/files/abc/download${qs}`, { headers });
}

const base = { Authorization: 'Bearer fake-jwt' };

describe('applyBffWorkspaceScopeFromNavigation', () => {
    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
    });
    afterEach(() => {
        delete process.env.WEB_URL;
    });

    it('reads the Organization selector from ?scope= and forwards it as x-scope-slug', () => {
        const headers = applyBffWorkspaceScopeFromNavigation(request({ query: 'org:ever' }), base);

        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('Authorization')).toBe('Bearer fake-jwt');
    });

    it('reads the personal selector from ?scope=', () => {
        const headers = applyBffWorkspaceScopeFromNavigation(request({ query: 'personal' }), base);

        expect(headers.get('x-scope-slug')).toBe('@personal');
    });

    it('falls back to the x-ever-workspace header when there is no query param (XHR callers)', () => {
        const headers = applyBffWorkspaceScopeFromNavigation(request({ header: 'org:ever' }), base);

        expect(headers.get('x-scope-slug')).toBe('ever');
    });

    it('lets the query param WIN when both are present — the navigation is the authority', () => {
        const headers = applyBffWorkspaceScopeFromNavigation(
            request({ query: 'org:ever', header: 'org:yo' }),
            base,
        );

        expect(headers.get('x-scope-slug')).toBe('ever');
    });

    it('overwrites a spoofed upstream x-scope-slug and never leaks the browser header', () => {
        const headers = applyBffWorkspaceScopeFromNavigation(request({ query: 'org:ever' }), base);

        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
    });

    /**
     * The fallback that makes this carrier safe to introduce. An old bookmark,
     * a stored `<img src>`, an API-minted URL in chat history — none carries a
     * selector, and every one of them ran personal before the carrier existed.
     * Personal is userId-gated upstream, so this narrows and widens nothing;
     * failing closed here would break every attachment tile in history.
     */
    it('runs PERSONAL when NEITHER carrier is present, instead of failing closed', () => {
        const headers = applyBffWorkspaceScopeFromNavigation(request(), base);

        expect(headers.get('x-scope-slug')).toBe('@personal');
        expect(headers.get('x-ever-workspace')).toBeNull();
    });

    it('skips the Referer check for a DEFAULTED selector — an old <img src> inside an Organization page keeps resolving', () => {
        const headers = applyBffWorkspaceScopeFromNavigation(
            request({ referer: 'http://web.example/org/ever/memory' }),
            base,
        );

        expect(headers.get('x-scope-slug')).toBe('@personal');
    });

    it('still fails closed on a PRESENT but empty ?scope= — that is a tampered value, not a missing one', () => {
        expect(() => applyBffWorkspaceScopeFromNavigation(request({ query: '' }), base)).toThrow(
            'Invalid workspace scope',
        );
    });

    it.each(['org:', 'org:Not Valid!', 'nonsense', 'org:ever;drop', '@personal'])(
        'rejects a malformed query value %j with the same grammar as the header',
        (bad) => {
            expect(() =>
                applyBffWorkspaceScopeFromNavigation(
                    request({ query: encodeURIComponent(bad) }),
                    base,
                ),
            ).toThrow('Invalid workspace scope');
        },
    );

    /**
     * The property that makes this carrier safe to put in a shareable URL. For a
     * navigation the Referer is the page the link sat on, so a copied-and-edited
     * `?scope=` that disagrees with where the user actually is fails closed.
     */
    it('rejects a query scope that disagrees with the Referer page', () => {
        expect(() =>
            applyBffWorkspaceScopeFromNavigation(
                request({ query: 'org:ever', referer: 'http://web.example/org/yo/memory' }),
                base,
            ),
        ).toThrow('Invalid workspace scope');
    });

    it('accepts a query scope that agrees with the Referer page', () => {
        const headers = applyBffWorkspaceScopeFromNavigation(
            request({ query: 'org:ever', referer: 'http://web.example/org/ever/memory' }),
            base,
        );

        expect(headers.get('x-scope-slug')).toBe('ever');
    });

    it('rejects a cross-origin Referer regardless of the query scope', () => {
        expect(() =>
            applyBffWorkspaceScopeFromNavigation(
                request({ query: 'org:ever', referer: 'http://evil.example/org/ever/memory' }),
                base,
            ),
        ).toThrow('Invalid workspace scope');
    });
});

describe('applyBffWorkspaceScope (header variant) is unchanged', () => {
    beforeEach(() => {
        process.env.WEB_URL = 'http://web.example';
    });
    afterEach(() => {
        delete process.env.WEB_URL;
    });

    /**
     * An XHR route must NOT honour `?scope=`. If it did, a crafted link could
     * steer a fetch the page's own transport believed it controlled. The refactor
     * that introduced the navigation variant must not have widened this one.
     */
    it('ignores ?scope= entirely and still requires the header', () => {
        expect(() => applyBffWorkspaceScope(request({ query: 'org:ever' }), base)).toThrow(
            'Invalid workspace scope',
        );
    });

    it('still forwards the header selector exactly as before', () => {
        const headers = applyBffWorkspaceScope(request({ header: 'org:ever' }), base);

        expect(headers.get('x-scope-slug')).toBe('ever');
        expect(headers.get('x-ever-workspace')).toBeNull();
    });
});

/**
 * The carrier is consumed at the BFF and never relayed: the API's global
 * ValidationPipe runs with `forbidNonWhitelisted`, so a forwarded `scope`
 * would be a 400 upstream on every route in this family.
 */
describe('upstreamSearchWithoutScope', () => {
    it('drops only the carrier and keeps the rest of the query', () => {
        expect(
            upstreamSearchWithoutScope(new URLSearchParams('source=upload&scope=org:ever')),
        ).toBe('?source=upload');
    });

    it('returns an empty string when the carrier was the only param', () => {
        expect(upstreamSearchWithoutScope(new URLSearchParams('scope=personal'))).toBe('');
    });

    it('does not mutate the caller’s params', () => {
        const params = new URLSearchParams('scope=personal&x=1');
        upstreamSearchWithoutScope(params);

        expect(params.get('scope')).toBe('personal');
    });
});
