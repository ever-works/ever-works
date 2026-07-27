import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { digestAPI, type DigestSettingsResponse } from '@/lib/api/digest';
import { DigestSettings } from '@/components/settings/DigestSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.digest');
    return { title: t('title') };
}

/**
 * Digest settings page.
 *
 * Server component: reads both settings records (personal + the active
 * organization's, when there is one) in a single call and hands them to
 * the client form.
 *
 * Graceful degradation: a hard fetch failure still renders the form
 * against a conservative default (everything off, no organization) with
 * a banner, so the user can retry a save and see the real server error
 * rather than a blown-up page. `aiConfigured: false` in that fallback
 * is the honest choice — if we cannot reach the API we cannot claim a
 * provider is configured.
 */
function fallbackSettings(): DigestSettingsResponse {
    return {
        personal: { enabled: false, cadence: 'daily' },
        organization: null,
        aiConfigured: false,
    };
}

export default async function DigestSettingsPage() {
    let initialSettings: DigestSettingsResponse;
    let loadError: string | null = null;

    try {
        initialSettings = await digestAPI.getSettings();
    } catch (error) {
        initialSettings = fallbackSettings();
        loadError = error instanceof Error ? error.message : 'Failed to load digest settings';
    }

    return <DigestSettings initialSettings={initialSettings} loadError={loadError} />;
}
