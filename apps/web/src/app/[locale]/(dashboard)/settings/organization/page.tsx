import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { OrganizationSettings } from '@/components/settings/OrganizationSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('organizations.settings');
    return { title: t('title') };
}

/**
 * PR-6 (domain-model evolution, review §23.5) — Organization settings
 * page. Thin server wrapper; the client component fetches the user's
 * Organizations through the shared `useOrganizations()` store and saves
 * the Vision field via `PATCH /api/organizations/:id`.
 */
export default function OrganizationSettingsPage() {
    return <OrganizationSettings />;
}
