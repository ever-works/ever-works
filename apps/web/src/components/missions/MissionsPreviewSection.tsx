'use client';

import { useMemo } from 'react';
import { CalendarClock, Target } from 'lucide-react';
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
        <section className="mt-8" aria-labelledby="missions-preview-heading">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2">
                    <Target className="w-5 h-5 text-warning" />
                    <h2
                        id="missions-preview-heading"
                        className="text-xl font-semibold text-text dark:text-text-dark"
                    >
                        {t('title')}
                    </h2>
                </div>
                {totalMissions > 0 && (
                    <Link
                        href={ROUTES.DASHBOARD_MISSIONS}
                        className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
                    >
                        {t('viewAll', { n: totalMissions })}
                    </Link>
                )}
            </div>

            {previewMissions.length === 0 ? (
                <div className="rounded-lg p-5 bg-card dark:bg-card-primary-dark/70 border border-card-border dark:border-white/9 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <p>{t('empty.title')}</p>
                    <p className="mt-1 text-xs">
                        {t.rich('empty.subtitleRich', {
                            link: (chunks) => (
                                <Link
                                    href={`/new?type=mission`}
                                    className="text-primary hover:underline"
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
                'group relative flex min-h-[10rem] flex-col overflow-hidden rounded-lg p-4 shadow-xs',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-white/9',
                'hover:border-primary-500/50 dark:hover:border-white/20',
                'transition-colors no-underline',
            )}
        >
            <div className="flex items-start gap-2 min-w-0">
                <div className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-warning/10 border border-warning/20">
                    <Target className="w-3.5 h-3.5 text-warning" strokeWidth={1.6} />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark leading-snug line-clamp-2">
                        {mission.title}
                    </h3>
                </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatusPill status={mission.status} />
                {isScheduled && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/5 dark:bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-info">
                        <CalendarClock className="w-3 h-3" />
                        {t('badges.scheduled')}
                    </span>
                )}
            </div>

            {/* Counter strip — Ideas / Works / Sites. Reserves all
                three columns even when Sites is 0 so brand-new
                accounts see the same layout as fully-utilized ones. */}
            <div className="mt-auto grid grid-cols-3 gap-1.5 pt-3">
                <CounterChip label={t('counters.ideas')} value={ideasCount} />
                <CounterChip label={t('counters.works')} value={worksCount} />
                <CounterChip label={t('counters.sites')} value={sitesCount} />
            </div>
        </Link>
    );
}

function CounterChip({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-md border border-border/60 dark:border-border-dark/60 px-2 py-1.5 text-center">
            <div className="text-[10px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                {label}
            </div>
            <div className="text-sm font-semibold text-text dark:text-text-dark">{value}</div>
        </div>
    );
}
