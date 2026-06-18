import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
    tenantJobRuntimeAPI,
    type TenantJobRuntimeConfigResponse,
} from '@/lib/api/tenant-job-runtime';
import { JobRuntimeSettings } from '@/components/settings/JobRuntimeSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.jobRuntime');
    return { title: t('title') };
}

/**
 * EW-742 P2.1 — tenant admin UI for the job-runtime overlay.
 *
 * Server component: fetches the current overlay (server-redacted —
 * `credentialsSecretRefRedacted` + `hasCredentials` only) and hands it
 * to the client form. The API endpoint is NULL-safe: when no overlay
 * row exists the controller returns a synthetic `mode: inherit` default
 * so the UI never has to special-case 404.
 *
 * Graceful degradation: a hard fetch failure (network, 5xx, missing
 * tenant 403) still renders the form with the same synthetic inherit
 * default. The form's actions will surface the real error on submit
 * rather than blowing up the page on first load.
 */
function inheritFallback(): TenantJobRuntimeConfigResponse {
    return {
        tenantId: '',
        providerId: null,
        mode: 'inherit',
        hasCredentials: false,
        credentialsSecretRefRedacted: null,
        credentialVersion: null,
        enabled: true,
        createdBy: null,
        createdAt: null,
        updatedAt: null,
    };
}

export default async function JobRuntimeSettingsPage() {
    let initialConfig: TenantJobRuntimeConfigResponse;
    let loadError: string | null = null;

    try {
        initialConfig = await tenantJobRuntimeAPI.getConfig();
    } catch (error) {
        initialConfig = inheritFallback();
        loadError = error instanceof Error ? error.message : 'Failed to load configuration';
    }

    return <JobRuntimeSettings initialConfig={initialConfig} loadError={loadError} />;
}
