'use client';

import { Target } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { StatusPill } from '@/components/work-agent';
import type { WorkMissionRelationDto } from '@/lib/api/missions';

/**
 * PR-2 (domain-model evolution) — "Missions" panel on the Work
 * Overview tab: the caller's Missions that relate to this Work via
 * explicit `mission_works` edges (reverse lookup,
 * `GET /me/missions/related-to-work/:workId`).
 *
 * Purely referential: Missions never own Works (invariant I-7), so
 * this panel is read-only context — attach/detach lives on the
 * Mission detail page. The Overview tab only renders it when at
 * least one relation exists.
 */

interface WorkMissionsProps {
    relations: WorkMissionRelationDto[];
}

export function WorkMissions({ relations }: WorkMissionsProps) {
    const t = useTranslations('dashboard.workDetail.missions');

    if (relations.length === 0) return null;

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-transparent',
                'border-card-border dark:border-border-secondary-dark',
            )}
            data-testid="work-missions-panel"
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark flex items-center gap-2">
                    <Target className="w-3.5 h-3.5 text-warning" />
                    {t('title')}
                </h3>
                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('subtitle')}
                </p>
            </div>
            <ul className="divide-y divide-card-border dark:divide-border-secondary-dark">
                {relations.map((r) => (
                    <li
                        key={r.id}
                        className="flex items-center gap-3 px-5 py-3"
                        data-testid={`work-missions-row-${r.missionId}-${r.relation}`}
                    >
                        <Link
                            href={ROUTES.DASHBOARD_MISSION(r.missionId)}
                            className="min-w-0 flex-1 truncate text-sm font-medium text-text dark:text-text-dark hover:text-primary transition-colors"
                        >
                            {r.missionTitle ?? r.missionId}
                        </Link>
                        <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            {t(`relations.${r.relation}`)}
                        </span>
                        {r.missionStatus && <StatusPill status={r.missionStatus} />}
                    </li>
                ))}
            </ul>
        </div>
    );
}
