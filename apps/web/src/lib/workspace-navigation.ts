import { buildWorkspaceHref, isOrganizationSlug, type WorkspaceScope } from './workspace-scope';
import { browserApiFetch } from './api/browser-api';

type WorkspaceLocation = Pick<Location, 'origin' | 'assign'>;

/**
 * Persist the user's fresh-login default only after the membership-validated
 * scope endpoint confirms the exact Organization selected by this tab.
 */
export async function persistActiveOrganization(organizationSlug: string): Promise<void> {
    if (!isOrganizationSlug(organizationSlug)) {
        throw new Error('Invalid Organization workspace');
    }

    const response = await browserApiFetch('/api/users/me/scope', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationSlug }),
    });
    if (!response.ok) {
        throw new Error(`Failed to persist active Organization (${response.status})`);
    }

    const persisted = (await response.json()) as { organizationSlug?: string | null };
    if (persisted.organizationSlug !== organizationSlug) {
        throw new Error('The persisted active Organization did not match the selection');
    }
}

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
