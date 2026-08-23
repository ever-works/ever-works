import { buildWorkspaceHref, isOrganizationSlug, type WorkspaceScope } from './workspace-scope';

type WorkspaceLocation = Pick<Location, 'origin' | 'assign'>;

/**
 * Cross a workspace boundary with a fresh document. This deliberately avoids
 * the client router so scope-sensitive caches and BFF requests are recreated
 * from the canonical visible pathname.
 */
export function navigateToWorkspaceDashboard(
    scope: WorkspaceScope,
    location: WorkspaceLocation = window.location,
): void {
    if (scope.kind === 'organization' && !isOrganizationSlug(scope.slug)) {
        throw new Error('Invalid Organization workspace');
    }

    const pathname = buildWorkspaceHref(scope, '/dashboard');
    const target = new URL(pathname, location.origin);
    if (target.origin !== location.origin) {
        throw new Error('Workspace navigation must remain same-origin');
    }

    location.assign(target.href);
}
