import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
    tenantJobRuntimeAPI,
    type TenantJobRuntimeConfigResponse,
    type TenantJobRuntimeProviderId,
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
 * `credentialsSecretRefRedacted` + `hasCredentials` only) and the
 * operator-allowed provider list (EW-742 P5 T34), then hands both to
 * the client form. The API endpoints are NULL-safe: when no overlay
 * row exists the controller returns a synthetic `mode: inherit`
 * default so the UI never has to special-case 404; the
 * available-providers endpoint returns ALL bundled providers when the
 * operator hasn't restricted it (fail-open).
 *
 * Graceful degradation: a hard fetch failure (network, 5xx, missing
 * tenant 403) still renders the form with the same synthetic inherit
 * default and the full bundled provider list as a fallback so the
 * form's actions can still surface the real error on submit rather
 * than blowing up the page on first load.
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

// Fallback when the available-providers fetch fails. Mirrors the
// bundled allow-list — the upsert API would block any provider the
// operator has actually disabled, so listing all five here only ever
// surfaces a clearer server-side error on save (vs. an empty picker
// the user can't recover from).
const BUNDLED_PROVIDERS: TenantJobRuntimeProviderId[] = [
    'trigger',
    'temporal',
    'bullmq',
    'pgboss',
    'inngest',
];

export default async function JobRuntimeSettingsPage() {
    let initialConfig: TenantJobRuntimeConfigResponse;
    let availableProviders: TenantJobRuntimeProviderId[];
    let loadError: string | null = null;

    // Fetch in parallel so the slower endpoint doesn't gate the faster
    // one. Both failures collapse into a single banner — the user only
    // needs one prompt to retry the page.
    const [configResult, providersResult] = await Promise.allSettled([
        tenantJobRuntimeAPI.getConfig(),
        tenantJobRuntimeAPI.getAvailableProviders(),
    ]);

    if (configResult.status === 'fulfilled') {
        initialConfig = configResult.value;
    } else {
        initialConfig = inheritFallback();
        loadError =
            configResult.reason instanceof Error
                ? configResult.reason.message
                : 'Failed to load configuration';
    }

    if (providersResult.status === 'fulfilled') {
        availableProviders = providersResult.value.providers;
    } else {
        availableProviders = BUNDLED_PROVIDERS;
        if (!loadError) {
            loadError =
                providersResult.reason instanceof Error
                    ? providersResult.reason.message
                    : 'Failed to load available providers';
        }
    }

    return (
        <JobRuntimeSettings
            initialConfig={initialConfig}
            availableProviders={availableProviders}
            loadError={loadError}
        />
    );
}
