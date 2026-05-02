import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import { SettingsForm } from '@/components/works/detail/settings/SettingsForm';
import { getAuthFromCookie } from '@/lib/auth';
import { canAccessSettings } from '@/lib/permissions';
import { notFound } from 'next/navigation';
import { getRepositoryVisibility } from '@/app/actions/dashboard/works';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('settings') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkSettingsPage({ params }: Params) {
    const { id } = await params;

    const user = await getAuthFromCookie();

    let work;
    try {
        const res = await workAPI.get(id);
        work = res.work;
    } catch {
        notFound();
    }

    // Server-side permission check: only managers and owners can access settings
    if (!canAccessSettings(work.userRole)) {
        notFound();
    }

    const repoVisibilityRes = await getRepositoryVisibility(id);
    const initialRepositories = repoVisibilityRes.success ? repoVisibilityRes.data : [];

    return (
        <div className="max-w-4xl">
            <SettingsForm
                work={work}
                user={user!}
                initialRepositories={initialRepositories || []}
            />
        </div>
    );
}
