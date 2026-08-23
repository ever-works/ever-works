'use client';

import { forwardRef, useMemo, type ComponentProps, type ComponentRef } from 'react';
import { buildWorkspaceHref, parseWorkspacePath } from '@/lib/workspace-scope';
import { navigationBase } from './navigation-base';

type LinkProps = ComponentProps<typeof navigationBase.Link>;
type LinkHref = LinkProps['href'];

type ObjectHref = {
    pathname: string;
    [key: string]: unknown;
};

export type WorkspaceNavigableHref = string | ObjectHref;

const PERSONAL_EXIT_PATHS = [
    '/auth',
    '/claim',
    '/forgot-password',
    '/login',
    '/logout',
    '/org-invite',
    '/register',
    '/reset-password',
    '/verify-email',
] as const;

function isPersonalExit(pathname: string): boolean {
    return PERSONAL_EXIT_PATHS.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
}

/**
 * Keep ordinary in-app navigation in the Organization namespace visible in
 * the current tab. Explicit canonical destinations, auth/public exits,
 * external URLs, fragments, and query-only changes retain their exact href.
 */
export function withWorkspaceHref<T extends WorkspaceNavigableHref>(
    href: T,
    currentPathname: string,
): T {
    let pathname: string;
    if (typeof href === 'string') {
        pathname = href;
    } else {
        pathname = href.pathname;
    }

    if (
        !pathname.startsWith('/') ||
        pathname.startsWith('//') ||
        pathname === '/org' ||
        pathname.startsWith('/org/') ||
        isPersonalExit(pathname)
    ) {
        return href;
    }

    let currentScope;
    try {
        currentScope = parseWorkspacePath(currentPathname);
    } catch {
        return href;
    }
    if (currentScope.kind !== 'organization') return href;

    const scopedPathname = buildWorkspaceHref(currentScope, pathname);
    return (
        typeof href === 'string'
            ? scopedPathname
            : { ...(href as ObjectHref), pathname: scopedPathname }
    ) as T;
}

/** Workspace-aware drop-in replacement for next-intl's Link. */
export const Link = forwardRef<ComponentRef<typeof navigationBase.Link>, LinkProps>(
    function WorkspaceLink({ href, ...props }, ref) {
        const pathname = navigationBase.usePathname();
        const scopedHref = withWorkspaceHref(href as WorkspaceNavigableHref, pathname) as LinkHref;
        return <navigationBase.Link ref={ref} href={scopedHref} {...props} />;
    },
);

/** Workspace-aware drop-in replacement for next-intl's client router. */
export function useRouter(): ReturnType<typeof navigationBase.useRouter> {
    const router = navigationBase.useRouter();
    const pathname = navigationBase.usePathname();

    return useMemo(() => {
        type Router = ReturnType<typeof navigationBase.useRouter>;
        const push: Router['push'] = ((href: WorkspaceNavigableHref, options?: unknown) =>
            router.push(
                withWorkspaceHref(href, pathname) as never,
                options as never,
            )) as Router['push'];
        const replace: Router['replace'] = ((href: WorkspaceNavigableHref, options?: unknown) =>
            router.replace(
                withWorkspaceHref(href, pathname) as never,
                options as never,
            )) as Router['replace'];
        const prefetch: Router['prefetch'] = ((href: WorkspaceNavigableHref, options?: unknown) =>
            router.prefetch(
                withWorkspaceHref(href, pathname) as never,
                options as never,
            )) as Router['prefetch'];

        return { ...router, push, replace, prefetch };
    }, [pathname, router]);
}

export const usePathname = navigationBase.usePathname;
