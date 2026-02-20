import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { directoryAPI } from '@/lib/api';
import { DirectoryStatusCard } from '@/components/directories/detail/DirectoryStatusCard';
import { DirectoryInfo } from '@/components/directories/detail/overview/DirectoryInfo';
import { DirectoryStats } from '@/components/directories/detail/overview/DirectoryStats';
import { DirectoryConfig } from '@/components/directories/detail/overview/DirectoryConfig';
import { GenerateStatusType } from '@/lib/api/enums';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('overview') };
}

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryOverviewPage({ params }: Params) {
    const { id } = await params;

    const [directoryRes, configRes, countRes] = await Promise.all([
        directoryAPI.get(id),
        directoryAPI.getConfig(id).catch(() => ({ config: null })),
        directoryAPI.getCount(id).catch(() => ({ items: 0, categories: 0, tags: 0 })),
    ]);

    const directory = directoryRes.directory;
    const config = configRes.config;

    const showStatusCard =
        !directory.generateStatus?.status ||
        directory.generateStatus?.status === GenerateStatusType.ERROR ||
        directory.generateStatus?.status === GenerateStatusType.GENERATING ||
        directory.generateStatus?.status === GenerateStatusType.CANCELLED ||
        (directory.generateStatus?.status === GenerateStatusType.GENERATED &&
            !!directory.generateStatus?.warnings?.length);

    return (
        <div className="space-y-6">
            {showStatusCard && <DirectoryStatusCard directory={directory} />}

            <DirectoryStats
                itemsCount={directory.itemsCount || countRes.items}
                categoriesCount={countRes.categories}
                tagsCount={countRes.tags}
                directory={directory}
            />

            {/* Directory Info and Config side by side */}
            <div className="grid lg:grid-cols-2 gap-6">
                <DirectoryInfo directory={directory} config={config} />
                {config && <DirectoryConfig config={config} />}
            </div>
        </div>
    );
}
