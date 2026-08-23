import { describe, expect, it } from 'vitest';
import {
    PERSONAL_SCOPE_SENTINEL,
    buildWorkspaceHref,
    getLegacyOrganizationDashboardRedirect,
    parseWorkspacePath,
    toApiScopeHeader,
} from './workspace-scope';

describe('workspace URL contract', () => {
    it.each([
        ['/org/ever/dashboard', { kind: 'organization', slug: 'ever' }],
        ['/org/yo/missions/new?from=template#details', { kind: 'organization', slug: 'yo' }],
        ['/org/en/dashboard', { kind: 'organization', slug: 'en' }],
        ['/dashboard', { kind: 'personal' }],
        ['/missions/new', { kind: 'personal' }],
    ] as const)('parses %s without consulting global preference state', (pathname, expected) => {
        expect(parseWorkspacePath(pathname)).toEqual(expected);
    });

    it.each([
        '/org//dashboard',
        '/org/../dashboard',
        '/org/%2F/dashboard',
        '/org/@personal/dashboard',
    ])('rejects malformed canonical Organization path %s', (pathname) => {
        expect(() => parseWorkspacePath(pathname)).toThrow('Invalid Organization workspace path');
    });

    it('uses a reserved personal sentinel that cannot collide with an Organization slug', () => {
        expect(PERSONAL_SCOPE_SENTINEL).toBe('@personal');
        expect(toApiScopeHeader({ kind: 'personal' })).toBe(PERSONAL_SCOPE_SENTINEL);
        expect(toApiScopeHeader({ kind: 'organization', slug: 'ever' })).toBe('ever');
        expect(PERSONAL_SCOPE_SENTINEL).not.toMatch(/^[a-z0-9-]+$/);
    });

    it.each([
        ['/ever/dashboard', '/org/ever/dashboard'],
        ['/yo/dashboard?tab=agents', '/org/yo/dashboard?tab=agents'],
    ] as const)('redirects only an unambiguous legacy Organization dashboard %s', (from, to) => {
        expect(getLegacyOrganizationDashboardRedirect(from, ['en', 'fr'])).toBe(to);
    });

    it.each([
        '/en/dashboard',
        '/fr/dashboard',
        '/org/dashboard',
        '/settings/dashboard',
        '/api/dashboard',
        '/ever/missions',
        '/https:%2F%2Fevil.example/dashboard',
    ])(
        'does not reinterpret reserved, locale, non-dashboard, or redirect-like path %s',
        (pathname) => {
            expect(getLegacyOrganizationDashboardRedirect(pathname, ['en', 'fr'])).toBeNull();
        },
    );

    it('prefixes app paths for an Organization but leaves personal paths unprefixed', () => {
        expect(
            buildWorkspaceHref({ kind: 'organization', slug: 'ever' }, '/missions/new?x=1#two'),
        ).toBe('/org/ever/missions/new?x=1#two');
        expect(buildWorkspaceHref({ kind: 'personal' }, '/missions/new?x=1#two')).toBe(
            '/missions/new?x=1#two',
        );
    });
});
