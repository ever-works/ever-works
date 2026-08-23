import { notFound, redirect } from 'next/navigation';
import { LOCALES } from '@/lib/constants';
import { getLegacyOrganizationDashboardRedirect } from '@/lib/workspace-scope';

interface OrganizationDashboardCompatibilityPageProps {
    params: Promise<{ slug: string }>;
}

/** Server fallback for bookmarks that bypassed the canonical proxy redirect. */
export default async function OrganizationDashboardCompatibilityPage({
    params,
}: OrganizationDashboardCompatibilityPageProps) {
    const { slug } = await params;
    const target = getLegacyOrganizationDashboardRedirect(`/${slug}/dashboard`, LOCALES);
    if (target === null) notFound();
    redirect(target);
}
