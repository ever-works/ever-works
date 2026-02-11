import { directoryAPI, pluginsAPI } from '@/lib/api';
import { DirectoryPluginsList } from '@/components/directories/detail/plugins/DirectoryPluginsList';
import { canAccessSettings } from '@/lib/permissions';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryPluginsPage({ params }: Params) {
    const { id } = await params;
    const t = await getTranslations('dashboard.directoryPlugins');

    const res = await directoryAPI.get(id);
    const directory = res.directory;

    // Server-side permission check: only managers and owners can access settings
    if (!canAccessSettings(directory.userRole)) {
        notFound();
    }

    const pluginsData = await pluginsAPI.listForDirectory(id);

    return (
        <div className="w-full">
            <div className="mb-6">
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark mt-1">{t('subtitle')}</p>
            </div>

            <DirectoryPluginsList
                directoryId={id}
                plugins={pluginsData.plugins}
                capabilityProviders={pluginsData.capabilityProviders}
            />
        </div>
    );
}
