import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { getWorkCapabilities } from '@ever-works/contracts';
import { workAPI } from '@/lib/api';
import { appBuildsWebAPI as appBuildsAPI } from '@/lib/api/app-builds';
import { ApiResponseError } from '@/lib/api/server-api';
import { canEdit } from '@/lib/permissions';
import type { AppBuildsListState } from '@/lib/works/app-builds.shared';
import { AppBuildsList } from '@/components/works/app/builds/AppBuildsList';
import { AppBuildPullTokenForm } from '@/components/works/app/builds/AppBuildPullTokenForm';

/**
 * APW-05 T25 — the Builds tab: `/works/:id/builds` (plan §6.1).
 *
 * Offered only to a kind whose capability set has `builds` (today `app` alone,
 * Resolution R-7); every other kind answers `notFound()`, so a bookmark cannot
 * render a Builds list for a Work that can never have one.
 *
 * First paint is the server's read of `GET /api/works/:id/builds`. A `404` from
 * that route means the Builds controller is not deployed on this instance yet
 * (it ships in the aw-builds lane) and renders a calm empty state; any other
 * failure renders the spec's load-error line. Neither turns the page into an
 * error boundary.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.workDetail.builds');
    return { title: t('title') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkBuildsPage({ params }: Params) {
    const { id } = await params;

    let work;
    try {
        work = (await workAPI.get(id)).work;
    } catch {
        notFound();
    }

    if (!getWorkCapabilities(work.kind).builds) {
        notFound();
    }

    let initialState: AppBuildsListState;
    try {
        initialState = { kind: 'ok', list: await appBuildsAPI.list(id) };
    } catch (error) {
        initialState =
            error instanceof ApiResponseError && error.statusCode === 404
                ? { kind: 'unavailable' }
                : { kind: 'error' };
    }

    const editable = canEdit(work.userRole);
    const list = initialState.kind === 'ok' ? initialState.list : null;
    // The pull token only matters for a private image; an image known to be
    // public needs none (spec §6.5 "This image is already public").
    const showPullToken = Boolean(list && list.pullAccess?.visibility !== 'public');

    return (
        <div className="space-y-6">
            <AppBuildsList workId={id} initialState={initialState} canEdit={editable} />
            {showPullToken && list && (
                <AppBuildPullTokenForm
                    workId={id}
                    canEdit={editable}
                    pullAccess={list.pullAccess}
                    imageRepository={list.imageRepository}
                />
            )}
        </div>
    );
}
