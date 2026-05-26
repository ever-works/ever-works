'use client';

import { Target } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { MissionCard } from './MissionCard';
import type { Mission } from '@/lib/api/missions';

/**
 * Phase 6 PR Q — Missions catalog list client.
 *
 * Spec: simple grid of MissionCards with creation routed through
 * the unified `/new?type=mission` flow. `/missions` deliberately
 * does NOT host its own quick-add form; empty accounts get one
 * focused CTA in the empty state instead of a duplicated header
 * and empty-state action.
 */
export function MissionsList({ missions }: { missions: Mission[] }) {
    const t = useTranslations('dashboard.missionsPage');
    const newMissionLabel = t('newMission').replace(/^\+\s*/, '');

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 mb-6">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-warning/10 border border-warning/20 flex items-center justify-center">
                        <Target className="w-4 h-4 text-warning" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </h1>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                            {t('subtitle')}
                        </p>
                    </div>
                </div>
                {missions.length > 0 && (
                    <Button asChild size="sm" className="gap-1.5 shrink-0">
                        <Link href={`/new?type=mission`}>{newMissionLabel}</Link>
                    </Button>
                )}
            </div>

            {/* List */}
            {missions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/70 dark:border-border-dark/70 bg-surface/40 dark:bg-surface-dark/30 p-8 text-center">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-warning/20 bg-warning/10">
                        <Target className="w-4 h-4 text-warning" />
                    </div>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('empty.title')}
                    </p>
                    <p className="mx-auto mt-1 max-w-2xl text-xs text-text-muted dark:text-text-muted-dark">
                        {t('empty.subtitle')}
                    </p>
                    <Button asChild size="sm" className="mt-4 gap-1.5">
                        <Link href={`/new?type=mission`}>{newMissionLabel}</Link>
                    </Button>
                </div>
            ) : (
                <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-4">
                    {missions.map((m) => (
                        <MissionCard key={m.id} mission={m} />
                    ))}
                </div>
            )}
        </div>
    );
}
