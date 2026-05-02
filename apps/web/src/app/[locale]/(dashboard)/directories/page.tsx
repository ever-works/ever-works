import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getDirectories, getDirectoryStats } from '@/app/actions/dashboard/directories';
import DirectoriesClient from './directories-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('works') };
}

export default async function DirectoriesPage() {
    // Fetch all directories with pagination
    const [response, statsResponse] = await Promise.all([
        getDirectories({ limit: 20, offset: 0 }).catch(() => ({
            success: false,
            directories: [],
            total: 0,
        })),
        getDirectoryStats().catch(() => ({
            success: false,
            totalDirectories: 0,
            totalItems: 0,
            activeWebsites: 0,
            generatingCount: 0,
        })),
    ]);

    return (
        <DirectoriesClient
            initialDirectories={response.directories}
            totalDirectories={response.total}
            initialStats={{
                totalDirectories: statsResponse.totalDirectories,
                totalItems: statsResponse.totalItems,
                generatingCount: statsResponse.generatingCount,
            }}
        />
    );
}
