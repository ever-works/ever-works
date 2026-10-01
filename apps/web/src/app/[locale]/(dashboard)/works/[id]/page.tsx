import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import { missionsAPI } from '@/lib/api/missions';
import { WorkStatusCard } from '@/components/works/detail/WorkStatusCard';
import { WorkInfo } from '@/components/works/detail/overview/WorkInfo';
import { WorkStats } from '@/components/works/detail/overview/WorkStats';
import { WorkConfig } from '@/components/works/detail/overview/WorkConfig';
import { WorkMissions } from '@/components/works/detail/overview/WorkMissions';
import { AppLauncherExposureCard } from '@/components/works/detail/overview/AppLauncherExposureCard';
import { AppUpstreamCard } from '@/components/works/app/AppUpstreamCard';
// The predicate is CALLED in this page's render body, so it must come from a
// module a server component may import: `AppUpstreamCard` is a client module
// (`'use client'`), and importing the function through it handed this page a
// client reference instead of the function, which threw out of the server
// render and replaced `/works/<id>` with Next's error boundary. The component
// itself stays imported from there — a component MAY cross the boundary; a
// plain function called on the server may not.
import { showUpstreamCardOnOverview } from '@/lib/works/app-upstream-visibility';
import { BudgetSummarySection } from '@/components/dashboard/BudgetSummarySection';
import { GenerateStatusType } from '@/lib/api/enums';
import { getAuthFromRequest } from '@/lib/auth';
import { isAppLauncherEnabled } from '@/lib/feature-flags/app-launcher';
import { notFound } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('overview') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkOverviewPage({ params }: Params) {
    const { id } = await params;

    let work;

    try {
        const workRes = await workAPI.get(id);
        work = workRes.work;
    } catch {
        notFound();
    }

    // PR-2 — my Missions that relate to this Work via explicit
    // `mission_works` edges. Defensive .catch: a flaky endpoint (or a
    // stale environment missing the migration) simply hides the panel
    // — WorkMissions also renders nothing when the list is empty.
    const missionRelations = await missionsAPI.listMissionsForWork(id).catch(() => []);

    // Counts + config come straight off the Work payload. The API
    // populates `configCache` / `*Count` from the data repo at
    // generator-completion time (and lazily backfills on first read
    // for legacy Works), so the Overview tab no longer needs a
    // per-render `cloneOrPull()` of the data repo. See
    // `DataGeneratorService.refreshDataCache`.
    const config = work.configCache ?? null;

    // APW-11 T17 (FR-59, ACC-11-45) — the exposure setting's second surface.
    //
    // The settings page answers `notFound()` unless `canAccessSettings`
    // (MANAGER+), while the API grants this change to EDITOR, so an editor could
    // make the choice and never reach the page offering it. This page has no role
    // gate, so the card renders the same state for editors and viewers alike.
    //
    // The flag is read from the JWT-backed request helper rather than a profile
    // fetch: it is a flag, not page data, and it must not add a round trip to
    // every Overview render (the same reasoning `settings/layout.tsx` records).
    // It is fail-closed, and a launcher that is off renders nothing here.
    const auth = await getAuthFromRequest();
    const appLauncherEnabled = await isAppLauncherEnabled(auth.user?.sub);

    // APW-02 T30 (Resolution R-8, plan §5.1) — the Upstream card's SECOND
    // surface. It sits directly below APW-01's App source card and renders only
    // for a fork or a private copy whose readiness is settled (`ready` or
    // `waiting_for_setup_pr`); every other readiness state belongs to APW-01's
    // card, which is the one that explains it. `showUpstreamCardOnOverview` is
    // the single place that rule lives.
    //
    // Only App Works are asked: `GET /api/works/:id/upstream` answers `404
    // not_found` for every other kind (ACC-02-21), which is a correct answer and
    // a wasted round trip. A failed read hides the card — the Overview must
    // never turn an unreadable upstream into a 404 page.
    const upstreamState =
        work.kind === 'app' ? await workAPI.getUpstream(id).catch(() => null) : null;

    const showStatusCard =
        !work.generateStatus?.status ||
        work.generateStatus?.status === GenerateStatusType.ERROR ||
        work.generateStatus?.status === GenerateStatusType.GENERATING ||
        work.generateStatus?.status === GenerateStatusType.CANCELLED ||
        (work.generateStatus?.status === GenerateStatusType.GENERATED &&
            !!work.generateStatus?.warnings?.length);

    return (
        <div className="space-y-6">
            {showStatusCard && <WorkStatusCard work={work} />}

            <WorkStats
                itemsCount={work.itemsCount ?? 0}
                categoriesCount={work.categoriesCount ?? 0}
                tagsCount={work.tagsCount ?? 0}
                comparisonsCount={work.comparisonsCount ?? 0}
                work={work}
            />

            {/* EW-602: per-Work budget overview + top plugins + spend trend */}
            <BudgetSummarySection workId={id} />

            {/* PR-2: Missions related to this Work — only when edges exist */}
            {missionRelations.length > 0 && <WorkMissions relations={missionRelations} />}

            {/* APW-11 T17 — Show in App Launcher, for every role that can reach
                the Overview (the settings-page equivalent is MANAGER+ only). */}
            {appLauncherEnabled && <AppLauncherExposureCard work={work} />}

            {/* APW-02 T30 (R-8) — the Upstream card, Overview variant: the same
                component as the Upstream tab, without the readiness row (the
                Overview is not where readiness is acted on). */}
            {showUpstreamCardOnOverview(upstreamState) && upstreamState && (
                <AppUpstreamCard workId={id} variant="overview" initialState={upstreamState} />
            )}

            {/* Work Info and Config side by side */}
            <div className="grid @3xl/main:grid-cols-2 gap-6">
                <WorkInfo work={work} config={config} />
                {config && <WorkConfig config={config} />}
            </div>
        </div>
    );
}
