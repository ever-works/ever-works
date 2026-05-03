import type { Metadata } from 'next';
import { workAPI, pluginsAPI } from '@/lib/api';
import { WorkPluginsList } from '@/components/works/detail/plugins/WorkPluginsList';
import { canAccessSettings } from '@/lib/permissions';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('plugins') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkPluginsPage({ params }: Params) {
    const { id } = await params;
    const t = await getTranslations('dashboard.workPlugins');

    let work;
    let pluginsData;

    try {
        const [res, pluginsResult] = await Promise.all([
            workAPI.get(id),
            pluginsAPI.listForWork(id),
        ]);

        work = res.work;
        pluginsData = pluginsResult;
    } catch {
        notFound();
    }

    // Server-side permission check: only managers and owners can access settings
    if (!canAccessSettings(work.userRole)) {
        notFound();
    }

    return (
        <div className="w-full">
            <div className="mb-6">
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark mt-1">{t('subtitle')}</p>
            </div>

            <WorkPluginsList
                workId={id}
                plugins={pluginsData.plugins}
                capabilityProviders={pluginsData.capabilityProviders}
            />
        </div>
    );
}
