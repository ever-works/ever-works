import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import { SettingsForm } from '@/components/works/detail/settings/SettingsForm';
import { getAuthFromCookie } from '@/lib/auth';
import { canAccessSettings } from '@/lib/permissions';
import { notFound } from 'next/navigation';
import { getRepositoryVisibility } from '@/app/actions/dashboard/works';
import { isAppLauncherEnabled } from '@/lib/feature-flags/app-launcher';

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

    // APW-11 T17 (APW11-G13) — this page is NOT under `settings/layout.tsx`
    // (that layout owns `/settings/*`), so it cannot receive the flag the nested
    // settings layout resolves; a parent layout cannot pass props into a page in
    // any case. The flag is therefore read here, with the same helper and the
    // same session id the dashboard shell and the settings layout use, and it
    // defaults to OFF on the way down: an unreachable config endpoint, a timeout
    // or a missing PostHog flag all leave the Work setting unrendered rather
    // than showing a control the API would refuse.
    const appLauncherEnabled = await isAppLauncherEnabled(user?.id);

    return (
        <div className="max-w-4xl">
            <SettingsForm
                work={work}
                user={user!}
                initialRepositories={initialRepositories || []}
                appLauncherEnabled={appLauncherEnabled}
            />
        </div>
    );
}
