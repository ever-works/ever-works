import { notFound, redirect } from 'next/navigation';
import type { ActiveScopeResponse } from '@ever-works/contracts/api';
import { ApiResponseError, serverFetch } from '@/lib/api/server-api';

interface OrganizationDashboardCompatibilityPageProps {
    params: Promise<{ slug: string }>;
}

/**
 * Compatibility entry point for the canonical Organization dashboard URL.
 * The switch mutation already happened through POST /api/users/me/scope;
 * this GET only validates that persisted state before entering legacy routes.
 */
export default async function OrganizationDashboardCompatibilityPage({
    params,
}: OrganizationDashboardCompatibilityPageProps) {
    const { slug } = await params;

    let activeScope: ActiveScopeResponse;
    try {
        activeScope = await serverFetch<ActiveScopeResponse>('/users/me/scope');
    } catch (error) {
        if (error instanceof ApiResponseError && error.statusCode === 404) {
            notFound();
        }
        throw error;
    }

    if (!activeScope.organizationId || activeScope.organizationSlug !== slug) {
        notFound();
    }

    redirect('/');
}
