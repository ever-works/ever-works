/**
 * Shapes shared by the Deploy tab's Dependencies card (client) and its server-only client / actions
 * (lane aw-deps-api, APW-07 T25). No `'use client'`, no `server-only`: both sides import it.
 *
 * Routes:
 *  - `GET    /api/works/:id/app-dependencies`                 → {@link AppDependenciesListResponse}
 *  - `PUT    /api/works/:id/app-dependencies/:kind`           → `202 { dependency }`
 *  - `POST   /api/works/:id/app-dependencies/:kind/provision` → `202` {@link AppDependencyRetryResponse}
 *    · `409 leaseHeld`
 *  - `DELETE /api/works/:id/app-dependencies/:kind` `{ confirmSlug }` → `202 { dependency }`
 *    · `422 confirmationMismatch` · `409 deleteInProgress`
 *
 * No answer ever carries a configuration or output value — names, kinds, statuses and counts only
 * (FR-5).
 */

import type {
    AppDependencyKind,
    AppDependencyStatus,
    AppDependencyView,
    AppDeployTarget,
} from '@ever-works/contracts';

export type { AppDependencyKind, AppDependencyStatus };

/** One card: the contract's view plus the provider label, resource names and attempt count. */
export interface AppDependencyEntry extends AppDependencyView {
    label: string;
    names: string[];
    attempts: number;
}

export interface AppDependenciesListResponse {
    workId: string;
    deployTarget: AppDeployTarget | null;
    dependencies: AppDependencyEntry[];
    refreshing: boolean;
    canEdit: boolean;
}

export interface AppDependencyRetryResponse {
    status: 'accepted';
    dispatched: boolean;
    reason?: string;
    dependency: AppDependencyEntry | null;
}

export interface AppDependencyWriteResponse {
    dependency: AppDependencyEntry | null;
}

/** The code an action answers when the routes are not deployed on this API (`404`). */
export const APP_DEPENDENCIES_ROUTE_UNAVAILABLE = 'route_unavailable';

/** The API's own `404` codes — any other `404` means the route itself is missing. */
export const APP_DEPENDENCIES_KNOWN_404_CODES = [
    'notAppWork',
    'appWorksDisabled',
    'dependencyNotDeclared',
] as const;

/** One action's answer. */
export interface AppDependencyActionResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    code?: string;
    httpStatus?: number;
}

/** Statuses a card keeps polling through — something is still happening (plan §6:858). */
export const APP_DEPENDENCY_BUSY_STATUSES: readonly AppDependencyStatus[] = [
    'pending',
    'provisioning',
    'deleting',
];

/**
 * The reasons a Deploy request retries on its own (mirrors the agent's
 * `APP_DEPENDENCY_TRANSIENT_FAILURE_REASONS`), so the card can say so.
 */
export const APP_DEPENDENCY_TRANSIENT_REASONS = ['clusterUnreachable', 'deadlineExceeded'] as const;

/** May the owner press **Retry** on this card? */
export function canRetryAppDependency(
    entry: Pick<AppDependencyEntry, 'status' | 'attempts'>,
): boolean {
    if (entry.status === 'failed' || entry.status === 'degraded') return true;
    // A row that is waiting out FR-43's five minutes between transient attempts can be nudged.
    return (entry.status === 'pending' || entry.status === 'provisioning') && entry.attempts > 0;
}

/** May the owner delete this dependency's data? Only where a provider may have created some. */
export function canDeleteAppDependencyDataOf(entry: Pick<AppDependencyEntry, 'status'>): boolean {
    return entry.status === 'ready' || entry.status === 'degraded' || entry.status === 'failed';
}

/** Is this failure one pressing Deploy retries? */
export function isTransientAppDependencyFailure(
    entry: Pick<AppDependencyEntry, 'status' | 'statusReason'>,
): boolean {
    return (
        entry.status === 'failed' &&
        (APP_DEPENDENCY_TRANSIENT_REASONS as readonly string[]).includes(entry.statusReason ?? '')
    );
}
