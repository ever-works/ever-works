'use client';

import { useMemo } from 'react';
import { CalendarClock, Plus, Target } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { StatusPill } from '@/components/work-agent';
import type { Mission } from '@/lib/api/missions';
import type { WorkProposal } from '@/lib/api/work-proposals';

/**
 * Phase 6 PR S — Dashboard Missions preview block. Slots ABOVE
 * the Ideas preview on the home page so the dashboard reads
 * Missions → Ideas → Works in the same direction as the spec
 * §5.1 stats tiles and the sidebar nav (Phase 6 PR Q).
 *
 * Each card surfaces three live counters per spec §5:
 *   - Ideas: count of every Idea attached to this Mission across
 *     all statuses (so the user sees the full pipeline volume,
 *     not just the actionable subset).
 *   - Works: count of Ideas that became Works (status = accepted
 *     and acceptedWorkId set).
 *   - Sites: count of deployed sites tied to this Mission. v1
 *     shows 0 across the board — the per-Mission deployment
 *     count needs wiring through the Works→Deployments join
 *     (lands in Phase 7 PR T / Phase 7 PR II). The card surface
 *     reserves the slot so the layout doesn't reshuffle later.
 *
 * Capped at `PREVIEW_LIMIT = 3` cards; "View all (N) →" link in
 * the corner routes to the full `/missions` catalog (PR Q). For
 * a user with zero Missions the section degrades to a small
 * "Start a Mission" empty state — non-noisy so a brand-new
 * account isn't shouted at.
 */
const PREVIEW_LIMIT = 3;

export interface MissionsPreviewSectionProps {
    missions: Mission[];
    /** All Ideas in the user's catalog (across all statuses). Used
     *  to derive per-Mission Ideas + Works counters on the client
     *  so the home page only round-trips once. */
    allIdeas: WorkProposal[];
}

export function MissionsPreviewSection({ missions, allIdeas }: MissionsPreviewSectionProps) {
    const t = useTranslations('dashboard.missionsPreview');

    // Group Ideas by missionId once. Counters are read off the map
    // per card so the render is O(missions + ideas), not
    // O(missions × ideas).
    const byMission = useMemo(() => {
        const map = new Map<string, { ideas: number; works: number }>();
        for (const idea of allIdeas) {
            if (!idea.missionId) continue;
            const bucket = map.get(idea.missionId) ?? { ideas: 0, works: 0 };
            bucket.ideas += 1;
            if (idea.status === 'accepted' && idea.acceptedWorkId) {
                bucket.works += 1;
            }
            map.set(idea.missionId, bucket);
        }
        return map;
    }, [allIdeas]);

    const totalMissions = missions.length;
    const previewMissions = missions.slice(0, PREVIEW_LIMIT);

    return (
        <section aria-labelledby="missions-preview-heading">
            <div className="flex flex-nowrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-surface-secondary dark:bg-white/6 border border-border/50 dark:border-white/10 flex items-center justify-center">
                        <Target className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                    </div>
                    <h2
                        id="missions-preview-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark truncate"
                    >
                        {t('title')}
                    </h2>
                </div>
                {/* Dashboard polish (2026-05-27) — `+ Add` button on
                    every dashboard section so the UI is symmetrical
                    (Missions / Ideas / Works / Tasks / Agents all
                    surface their own create entry point). */}
                <div className="flex flex-nowrap items-center gap-2 shrink-0">
                    <Link
                        href="/new?type=mission"
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-150 whitespace-nowrap',
                            'border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark',
                            'text-text-secondary dark:text-text-secondary-dark',
                            'hover:border-border dark:hover:border-white/16',
                        )}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Add
                    </Link>
                    {totalMissions > 0 && (
                        <Link
                            href={ROUTES.DASHBOARD_MISSIONS}
                            className="text-xs font-medium text-primary hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                        >
                            {t('viewAll', { n: totalMissions })}
                        </Link>
                    )}
                </div>
            </div>

            {previewMissions.length === 0 ? (
                <div className="rounded-lg p-5 bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p>{t('empty.title')}</p>
                    <p className="mt-1 text-xs">
                        {t.rich('empty.subtitleRich', {
                            link: (chunks) => (
                                <Link
                                    href={`/new?type=mission`}
                                    className="text-primary text-xs hover:underline"
                                >
                                    {chunks}
                                </Link>
                            ),
                        })}
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {previewMissions.map((m) => {
                        const counts = byMission.get(m.id) ?? { ideas: 0, works: 0 };
                        return (
                            <MissionPreviewCard
                                key={m.id}
                                mission={m}
                                ideasCount={counts.ideas}
                                worksCount={counts.works}
                                sitesCount={0}
                            />
                        );
                    })}
                </div>
            )}
        </section>
    );
}

function MissionPreviewCard({
    mission,
    ideasCount,
    worksCount,
    sitesCount,
}: {
    mission: Mission;
    ideasCount: number;
    worksCount: number;
    sitesCount: number;
}) {
    const t = useTranslations('dashboard.missionsPreview');
    const isScheduled = mission.type === 'scheduled';
    return (
        <Link
            href={ROUTES.DASHBOARD_MISSION(mission.id)}
            className={cn(
                'group flex flex-col gap-3 rounded-xl p-4 no-underline',
                'bg-card dark:bg-card-primary-dark/60',
                'border border-card-border dark:border-white/8',
                'hover:border-border dark:hover:border-white/16',
                'transition-colors duration-150',
            )}
        >
            {/* Title + icon */}
            <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark leading-snug line-clamp-2">
                    {mission.title}
                </h3>
                {/* <div className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center bg-warning/10">
                    <Target className="w-3.5 h-3.5 text-warning" strokeWidth={1.5} />
                </div> */}
            </div>

            {/* Badges */}
            <div className="flex flex-wrap items-center gap-1.5">
                <StatusPill status={mission.status} />
                {isScheduled && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-info/25 bg-info/8 dark:bg-info/12 px-1.5 py-0.5 text-[10px] font-normal text-info">
                        <CalendarClock className="w-3 h-3" />
                        {t('badges.scheduled')}
                    </span>
                )}
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-3 pt-1 border-t border-card-border/50 dark:border-white/6">
                <MissionStat label={t('counters.ideas')} value={ideasCount} />
                <div className="w-px h-3.5 bg-card-border dark:bg-white/10 shrink-0" />
                <MissionStat label={t('counters.works')} value={worksCount} />
                <div className="w-px h-3.5 bg-card-border dark:bg-white/10 shrink-0" />
                <MissionStat label={t('counters.sites')} value={sitesCount} />
            </div>
        </Link>
    );
}

function MissionStat({ label, value }: { label: string; value: number }) {
    return (
        <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-sm font-bold text-text dark:text-text-dark tabular-nums">
                {value}
            </span>
            <span className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                {label}
            </span>
        </div>
    );
}
