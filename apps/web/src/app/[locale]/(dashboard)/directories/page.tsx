import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getDirectories } from '@/app/actions/dashboard/directories';
import DirectoriesClient from './directories-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('directories') };
}

export default async function DirectoriesPage() {
    // Fetch all directories with pagination
    const response = await getDirectories({ limit: 20, offset: 0 });

    return (
        <DirectoriesClient
            initialDirectories={response.directories}
            totalDirectories={response.total}
        />
    );
}
