import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { authAPI } from '@/lib/api';
import { operatorTenantRuntimeAllowlistAPI } from '@/lib/api/operator-tenant-runtime-allowlist';
import { TenantRuntimeAllowlistManager } from '@/components/admin/TenantRuntimeAllowlistManager';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Tenant runtime allow-list',
};

interface PageProps {
    params: Promise<{ tenantId: string }>;
}

/**
 * EW-742 P5.1 (T35a UI follow-up) — operator admin page for the
 * per-tenant runtime provider allow-list.
 *
 * Lives at `/[locale]/admin/tenants/:tenantId/runtime-allowlist`.
 * The backend's `IsPlatformAdminGuard` (on
 * `OperatorTenantRuntimeAllowlistController`) is the authoritative
 * gate; this page also performs a defense-in-depth `isPlatformAdmin`
 * check on the profile and 404s for non-admins so the route does not
 * leak its existence via a distinctive error message — mirrors the
 * `/admin/usage` page (EW-602).
 */
export default async function TenantRuntimeAllowlistAdminPage({ params }: PageProps) {
    const t = await getTranslations('dashboard.adminTenantRuntimeAllowlist');
    const { tenantId } = await params;

    // Security: defense-in-depth — verify the caller holds the platform-admin
    // flag before issuing the admin API call. The backend's `IsPlatformAdminGuard`
    // is the authoritative check; this is a redundant frontend layer so that a
    // future misconfiguration of the backend guard does not silently expose data.
    const profile = await authAPI.getProfile().catch(() => null);
    if (!profile?.isPlatformAdmin) {
        notFound();
    }

    let initial;
    try {
        initial = await operatorTenantRuntimeAllowlistAPI.list(tenantId);
    } catch {
        // Treat any fetch failure (403 from a backend-side guard
        // mismatch, 404 from an unknown tenant, etc.) as "not allowed"
        // so the route stays invisible. The page is operator-only and
        // the error detail is not useful to non-operators.
        notFound();
    }

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
                <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('subtitle')}
                </p>
                <p className="mt-2 font-mono text-xs text-text-muted dark:text-text-muted-dark break-all">
                    {tenantId}
                </p>
            </header>

            <TenantRuntimeAllowlistManager tenantId={tenantId} initial={initial} />
        </div>
    );
}
