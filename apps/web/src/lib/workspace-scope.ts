// Runtime twins of the public `@ever-works/contracts/api` constants. Keeping
// the tiny web boundary self-contained avoids loading the server contract
// package into browser chunks; the contract spec pins the exact same values.
export const PERSONAL_SCOPE_SENTINEL = '@personal' as const;
export const API_SCOPE_HEADER = 'x-scope-slug' as const;
export const BROWSER_WORKSPACE_SCOPE_HEADER = 'x-ever-workspace' as const;

const ORGANIZATION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CANONICAL_ORGANIZATION_PREFIX = '/org/';

/** First path segments owned by the application rather than an Organization. */
const RESERVED_LEGACY_ORGANIZATION_SLUGS = new Set([
    'api',
    'auth',
    'dashboard',
    'login',
    'logout',
    'onboarding',
    'org',
    'organizations',
    'profile',
    'register',
    'settings',
    'signup',
    'verify-email',
]);

export type WorkspaceScope =
    | { readonly kind: 'personal' }
    | { readonly kind: 'organization'; readonly slug: string };

function splitPathSuffix(value: string): { pathname: string; suffix: string } {
    const suffixIndex = value.search(/[?#]/);
    return suffixIndex === -1
        ? { pathname: value, suffix: '' }
        : { pathname: value.slice(0, suffixIndex), suffix: value.slice(suffixIndex) };
}

/**
 * Parse the visible browser pathname. The URL is the request authority: this
 * function deliberately has no access to cookies, local storage, or the user's
 * persisted last-Organization preference.
 */
export function parseWorkspacePath(value: string): WorkspaceScope {
    const { pathname } = splitPathSuffix(value);
    if (pathname === '/org' || pathname.startsWith(CANONICAL_ORGANIZATION_PREFIX)) {
        const segments = pathname.split('/');
        const slug = segments[2] ?? '';
        if (!ORGANIZATION_SLUG.test(slug)) {
            throw new Error('Invalid Organization workspace path');
        }
        return { kind: 'organization', slug };
    }

    return { kind: 'personal' };
}

export function toApiScopeHeader(scope: WorkspaceScope): string {
    return scope.kind === 'organization' ? scope.slug : PERSONAL_SCOPE_SENTINEL;
}

export function serializeWorkspaceScope(scope: WorkspaceScope): string {
    return scope.kind === 'organization' ? `org:${scope.slug}` : 'personal';
}

export function parseWorkspaceSelector(value: string | null): WorkspaceScope {
    if (value === 'personal') return { kind: 'personal' };
    if (value?.startsWith('org:')) {
        const slug = value.slice('org:'.length);
        if (ORGANIZATION_SLUG.test(slug)) {
            return { kind: 'organization', slug };
        }
    }
    throw new Error('Invalid workspace scope');
}

/** Build a canonical workspace-aware app href from an existing unprefixed href. */
export function buildWorkspaceHref(scope: WorkspaceScope, href: string): string {
    if (!href.startsWith('/') || href.startsWith('//')) {
        throw new Error('Workspace href must be an absolute same-origin path');
    }
    if (scope.kind === 'personal') return href;
    if (href.startsWith(CANONICAL_ORGANIZATION_PREFIX)) return href;
    return `${CANONICAL_ORGANIZATION_PREFIX}${scope.slug}${href}`;
}

/**
 * Query-string carrier for BFF routes a browser NAVIGATES to.
 *
 * `<a href download>`, `<img src>`, `<video src>` and `<iframe src>` cannot
 * carry `x-ever-workspace`, and Next middleware cannot add it because its
 * matcher excludes `/api`. Those routes read the selector from `?scope=`
 * instead — the SAME grammar as the header (`personal` | `org:<slug>`), so the
 * two carriers cannot disagree about what a valid selector is.
 */
export const WORKSPACE_SCOPE_QUERY_PARAM = 'scope' as const;

/**
 * Put the workspace selector on a same-origin BFF href. Pure: the caller
 * supplies the scope (from `useWorkspaceScope()` in a component), so this can
 * run during server rendering without touching `window`.
 *
 * Same-origin relative hrefs only, on purpose — this is for BFF routes, and
 * silently decorating a foreign URL would hide a bug rather than leak anything.
 */
export function withWorkspaceScopeQuery(href: string, scope: WorkspaceScope): string {
    if (!href.startsWith('/') || href.startsWith('//')) {
        throw new Error('Workspace scope query requires a same-origin relative href');
    }
    const url = new URL(href, 'http://n');
    url.searchParams.set(WORKSPACE_SCOPE_QUERY_PARAM, serializeWorkspaceScope(scope));
    return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Return the sole supported compatibility redirect. It accepts exactly
 * `/{slug}/dashboard`, excludes locale and reserved app segments, and can only
 * construct a same-origin relative target.
 */
export function getLegacyOrganizationDashboardRedirect(
    value: string,
    locales: readonly string[],
): string | null {
    const { pathname, suffix } = splitPathSuffix(value);
    const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)\/dashboard\/?$/.exec(pathname);
    if (!match) return null;

    const slug = match[1];
    if (RESERVED_LEGACY_ORGANIZATION_SLUGS.has(slug) || locales.includes(slug)) {
        return null;
    }
    return `/org/${slug}/dashboard${suffix}`;
}

export function isOrganizationSlug(value: string): boolean {
    return ORGANIZATION_SLUG.test(value);
}
