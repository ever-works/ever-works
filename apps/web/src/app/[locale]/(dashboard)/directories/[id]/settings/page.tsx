import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { directoryAPI } from '@/lib/api';
import { SettingsForm } from '@/components/directories/detail/settings/SettingsForm';
import { getAuthFromCookie } from '@/lib/auth';
import { canAccessSettings } from '@/lib/permissions';
import { notFound } from 'next/navigation';
import { getRepositoryVisibility } from '@/app/actions/dashboard/directories';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('settings') };
}

type Params = { params: Promise<{ id: string }> };

export default async function DirectorySettingsPage({ params }: Params) {
    const { id } = await params;

    const user = await getAuthFromCookie();
    const res = await directoryAPI.get(id);
    const directory = res.directory;

    // Server-side permission check: only managers and owners can access settings
    if (!canAccessSettings(directory.userRole)) {
        notFound();
    }

    const repoVisibilityRes = await getRepositoryVisibility(id);
    const initialRepositories = repoVisibilityRes.success ? repoVisibilityRes.data : [];

    return (
        <div className="max-w-4xl">
            <SettingsForm
                directory={directory}
                user={user!}
                initialRepositories={initialRepositories || []}
            />
        </div>
    );
}
