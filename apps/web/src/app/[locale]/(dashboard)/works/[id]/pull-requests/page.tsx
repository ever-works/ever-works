import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { pullRequestsAPI, type WorkRepoPullRequestsView } from '@/lib/api/pull-requests';
import { WorkPullRequestsClient } from '@/components/works/detail/pull-requests/WorkPullRequestsClient';

/**
 * Wave 7 feature h — the Work "Pull requests" tab.
 *
 * The first page is fetched server-side so the tab renders with content
 * instead of a spinner; the client component owns refresh, selection and
 * the review action from there. A listing failure is passed down as
 * `initialError` rather than thrown — a Work whose git provider is not
 * connected should still render its tab.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workDetail.pullRequests');
    return { title: t('title') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkPullRequestsPage({ params }: Params) {
    const { id } = await params;

    try {
        await workAPI.get(id);
    } catch {
        notFound();
    }

    let repos: WorkRepoPullRequestsView[] = [];
    let initialError: string | null = null;
    try {
        const data = await pullRequestsAPI.list(id);
        repos = data.repos ?? [];
    } catch (error) {
        initialError = error instanceof Error ? error.message : String(error);
    }

    return <WorkPullRequestsClient workId={id} initialRepos={repos} initialError={initialError} />;
}
