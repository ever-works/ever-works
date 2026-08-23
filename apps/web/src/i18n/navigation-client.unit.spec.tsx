import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigationMocks = vi.hoisted(() => ({
    pathname: '/org/ever/dashboard',
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
}));

vi.mock('next-intl/navigation', () => ({
    createNavigation: () => ({
        Link: ({ href, children, ...props }: React.ComponentProps<'a'> & { href: unknown }) => (
            <a
                {...props}
                href={
                    typeof href === 'string'
                        ? href
                        : String((href as unknown as { pathname?: string }).pathname ?? '')
                }
            >
                {children}
            </a>
        ),
        getPathname: vi.fn(),
        redirect: vi.fn(),
        usePathname: () => navigationMocks.pathname,
        useRouter: () => ({
            back: vi.fn(),
            forward: vi.fn(),
            refresh: vi.fn(),
            push: navigationMocks.push,
            replace: navigationMocks.replace,
            prefetch: navigationMocks.prefetch,
        }),
    }),
}));

vi.mock('next-intl/routing', () => ({
    defineRouting: (value: unknown) => value,
}));

import { Link, useRouter, withWorkspaceHref } from './navigation-client';

function RouterProbe() {
    const router = useRouter();
    return (
        <>
            <button onClick={() => router.push('/missions')}>push</button>
            <button onClick={() => router.replace('/goals')}>replace</button>
            <button onClick={() => router.prefetch('/agents')}>prefetch</button>
        </>
    );
}

describe('workspace-aware navigation', () => {
    beforeEach(() => {
        navigationMocks.pathname = '/org/ever/dashboard';
        vi.clearAllMocks();
    });

    it('keeps a relative app destination in the current Organization namespace', () => {
        expect(withWorkspaceHref('/agents', '/org/ever/missions')).toBe('/org/ever/agents');
    });

    it('keeps UrlObject query state while adding the Organization namespace', () => {
        expect(
            withWorkspaceHref(
                { pathname: '/goals', query: { view: 'archived' } },
                '/org/yo/dashboard',
            ),
        ).toEqual({ pathname: '/org/yo/goals', query: { view: 'archived' } });
    });

    it('does not double-prefix an already canonical Organization destination', () => {
        expect(withWorkspaceHref('/org/yo/agents', '/org/ever/missions')).toBe('/org/yo/agents');
    });

    it.each(['/login', '/register', '/auth/error', '/org-invite/token', '/claim/token'])(
        'leaves the personal/public exit %s outside the Organization namespace',
        (href) => {
            expect(withWorkspaceHref(href, '/org/ever/dashboard')).toBe(href);
        },
    );

    it('leaves external, fragment, query-only, and explicitly personal navigation unchanged', () => {
        expect(withWorkspaceHref('https://example.com', '/org/ever/dashboard')).toBe(
            'https://example.com',
        );
        expect(withWorkspaceHref('#details', '/org/ever/dashboard')).toBe('#details');
        expect(withWorkspaceHref('?tab=runs', '/org/ever/dashboard')).toBe('?tab=runs');
        expect(withWorkspaceHref('/agents', '/agents')).toBe('/agents');
    });

    it('applies the workspace transform through the exported Link', () => {
        render(<Link href="/agents">Agents</Link>);
        expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute(
            'href',
            '/org/ever/agents',
        );
    });

    it('applies the workspace transform through push, replace, and prefetch', () => {
        render(<RouterProbe />);
        fireEvent.click(screen.getByRole('button', { name: 'push' }));
        fireEvent.click(screen.getByRole('button', { name: 'replace' }));
        fireEvent.click(screen.getByRole('button', { name: 'prefetch' }));

        expect(navigationMocks.push).toHaveBeenCalledWith('/org/ever/missions', undefined);
        expect(navigationMocks.replace).toHaveBeenCalledWith('/org/ever/goals', undefined);
        expect(navigationMocks.prefetch).toHaveBeenCalledWith('/org/ever/agents', undefined);
    });
});
