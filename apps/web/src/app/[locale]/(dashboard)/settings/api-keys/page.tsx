import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { apiKeysAPI } from '@/lib/api/api-keys';
import { teamsAPI } from '@/lib/api/teams';
import { ApiKeysSettings } from '@/components/settings/ApiKeysSettings';
import { IntegrationKeysSection } from '@/components/settings/IntegrationKeysSection';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('apiKeys') };
}

function firstParam(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export default async function ApiKeysSettingsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    let initialKeys: Awaited<ReturnType<typeof apiKeysAPI.list>> = [];
    try {
        initialKeys = await apiKeysAPI.list();
    } catch {
        initialKeys = [];
    }

    // EW-P1-7 — integration keys (`ew_int_…`), listed apart from personal keys.
    // The workspace owner sees them; anyone else gets an empty list.
    let integrationKeys: Awaited<ReturnType<typeof apiKeysAPI.listIntegration>> = [];
    try {
        integrationKeys = await apiKeysAPI.listIntegration();
    } catch {
        integrationKeys = [];
    }
    const organizations = await teamsAPI.listOrganizations();

    // Deep link: `?new=integration&preset=ever-gauzy` opens the dialog preset.
    const params = await searchParams;
    const openIntegrationDialog = firstParam(params.new) === 'integration';
    const preset = firstParam(params.preset);

    return (
        <div className="space-y-12">
            <ApiKeysSettings initialKeys={initialKeys} />
            <IntegrationKeysSection
                initialKeys={integrationKeys}
                organizations={organizations.map((org) => ({
                    id: org.id,
                    slug: org.slug,
                    displayName: org.displayName,
                }))}
                openOnArrival={openIntegrationDialog}
                initialPreset={preset}
            />
        </div>
    );
}
