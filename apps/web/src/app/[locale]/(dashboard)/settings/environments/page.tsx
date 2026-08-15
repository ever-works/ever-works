import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { environmentsAPI, type Environment } from '@/lib/api/environments';
import { EnvironmentsSettings } from '@/components/settings/EnvironmentsSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.environments');
    return { title: t('title') };
}

/**
 * Environments (Settings → Environments) — server component: fetches the
 * caller's Environments and hands them to the client list/editor.
 *
 * Graceful degradation: a hard fetch failure still renders the page with
 * an empty list + a banner, so the create flow can surface the real
 * error on submit rather than blowing up the page on first load (same
 * posture as the Job Runtime settings page).
 */
export default async function EnvironmentsSettingsPage() {
    let initialEnvironments: Environment[] = [];
    let loadError: string | null = null;

    try {
        initialEnvironments = await environmentsAPI.list();
    } catch (error) {
        loadError = error instanceof Error ? error.message : 'Failed to load environments';
    }

    return <EnvironmentsSettings initialEnvironments={initialEnvironments} loadError={loadError} />;
}
