import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { authAPI } from '@/lib/api';
import { everIdAPI } from '@/lib/api/ever-id';
import { EverIdAdminClient } from './ever-id-admin-client';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.admin.everId');
    return { title: t('title') };
}

/**
 * APW-12 (Ever ID) — the administrator surface (S10, spec §6.7, T51). Reached by
 * its address only, like `/admin/usage`: there is no navigation entry.
 *
 * Platform administrators only, gated the way `/admin/usage` and the plugin
 * allowlist page are: an explicit `isPlatformAdmin === false` on the profile
 * short-circuits to the ordinary 404, and the API's own guard is authoritative —
 * it answers 404 to anyone else, which this page turns into `notFound()` too, so
 * the route stays invisible instead of advertising itself with an error.
 *
 * Only the administrator-managed values (display name, account management
 * address, terminal clients, app names) can be changed here. The issuer, the
 * client and its secret come from the environment, and the secret is only ever
 * reported as set or not set.
 */
export default async function EverIdAdminPage() {
    const profile = await authAPI.getProfile().catch(() => null);
    if (profile?.isPlatformAdmin === false) {
        notFound();
    }

    const [statusResult, healthResult] = await Promise.allSettled([
        everIdAPI.adminStatus(),
        everIdAPI.adminHealth(),
    ]);

    if (statusResult.status !== 'fulfilled') {
        notFound();
    }

    return (
        <EverIdAdminClient
            initialStatus={statusResult.value}
            initialHealth={healthResult.status === 'fulfilled' ? healthResult.value : null}
        />
    );
}
