import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import { missionsAPI } from '@/lib/api/missions';
import { WorkStatusCard } from '@/components/works/detail/WorkStatusCard';
import { WorkInfo } from '@/components/works/detail/overview/WorkInfo';
import { WorkStats } from '@/components/works/detail/overview/WorkStats';
import { WorkConfig } from '@/components/works/detail/overview/WorkConfig';
import { WorkMissions } from '@/components/works/detail/overview/WorkMissions';
import { BudgetSummarySection } from '@/components/dashboard/BudgetSummarySection';
import { GenerateStatusType } from '@/lib/api/enums';
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

            {/* Work Info and Config side by side */}
            <div className="grid @3xl/main:grid-cols-2 gap-6">
                <WorkInfo work={work} config={config} />
                {config && <WorkConfig config={config} />}
            </div>
        </div>
    );
}
