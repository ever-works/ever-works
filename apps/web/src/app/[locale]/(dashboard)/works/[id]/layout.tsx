import type { Metadata } from 'next';
import { Work, workAPI, gitProvidersAPI, GitProviderConnectionInfo } from '@/lib/api';
import { notFound } from 'next/navigation';
import { WorkLayoutClient } from '@/components/works/detail/WorkLayoutClient';
import { getTranslations } from 'next-intl/server';
import { APP_NAME } from '@/lib/constants';

type LayoutParams = {
    params: Promise<{ id: string }>;
    children: React.ReactNode;
};

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string }>;
}): Promise<Metadata> {
    const { id } = await params;
    const t = await getTranslations('metadata.pages');
    try {
        const { work } = await workAPI.get(id);
        return {
            title: {
                template: `%s - ${work.name} | ${APP_NAME}`,
                default: work.name,
            },
        };
    } catch {
        return { title: t('work') };
    }
}

export default async function WorkLayout({ params, children }: LayoutParams) {
    const { id } = await params;

    let work: Work;
    let oauthConnection: GitProviderConnectionInfo | null = null;
    let config = null;

    try {
        const res = await workAPI.get(id);
        work = res.work;
        // Sourced from the cached `works.yml` payload the API
        // populated alongside the Work row. No extra git clone
        // needed; see `DataGeneratorService.refreshDataCache`.
        config = work.configCache ?? null;

        if (work) {
            // Fetch connection info and provider list in parallel
            const [connectionRes, providersRes] = await Promise.all([
                gitProvidersAPI.checkConnection(work.gitProvider).catch(() => null),
                gitProvidersAPI.list().catch(() => null),
            ]);

            oauthConnection = connectionRes;

            // If checkConnection failed but we have provider info from the list,
            // build a minimal connection object so repo links still work
            if (!oauthConnection && providersRes) {
                const provider = providersRes.providers?.find((p) => p.id === work.gitProvider);
                if (provider) {
                    oauthConnection = { ...provider, connected: false };
                }
            }
        }
    } catch (error) {
        console.error('Failed to fetch Work:', error);
        notFound();
    }

    return (
        <WorkLayoutClient work={work} oauthConnection={oauthConnection} config={config}>
            {children}
        </WorkLayoutClient>
    );
}
