import { notFound, redirect } from 'next/navigation';
import { serverFetch } from '@/lib/api/server-api';

interface ActiveScopeResponse {
    tenantId: string | null;
    organizationId: string | null;
    organizationSlug: string | null;
}

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
    } catch {
        notFound();
    }

    if (!activeScope.organizationId || activeScope.organizationSlug !== slug) {
        notFound();
    }

    redirect('/');
}
