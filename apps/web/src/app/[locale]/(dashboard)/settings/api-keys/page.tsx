import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { apiKeysAPI } from '@/lib/api/api-keys';
import { ApiKeysSettings } from '@/components/settings/ApiKeysSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('apiKeys') };
}

export default async function ApiKeysSettingsPage() {
    let initialKeys: Awaited<ReturnType<typeof apiKeysAPI.list>> = [];
    try {
        initialKeys = await apiKeysAPI.list();
    } catch {
        initialKeys = [];
    }

    return <ApiKeysSettings initialKeys={initialKeys} />;
}
