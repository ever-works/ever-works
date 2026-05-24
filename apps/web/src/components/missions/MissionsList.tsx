'use client';

import { Plus, Target } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { MissionCard } from './MissionCard';
import type { Mission } from '@/lib/api/missions';

/**
 * Phase 6 PR Q — Missions catalog list client.
 *
 * Spec: simple grid of MissionCards, top-right "+ New Mission"
 * button that routes to the unified `/new` (Phase 6.5 PR CC2) —
 * `/missions` deliberately does NOT host its own quick-add form.
 * Empty-state surface is a friendly nudge with the same CTA so
 * a brand-new account has a clear way in.
 *
 * Until Phase 6.5 lands, the "+ New Mission" button routes to
 * `/new?type=mission` as a forward-compatible pointer; the
 * `/new` page itself ships in PR CC2 and reads the `type` query
 * param to pre-fill its chip selection.
 */
export function MissionsList({ missions }: { missions: Mission[] }) {
    const t = useTranslations('dashboard.missionsPage');

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
                <Button asChild size="sm" className="gap-1.5 shrink-0">
                    <Link href={`/new?type=mission`}>
                        <Plus className="w-3.5 h-3.5" />
                        {t('newMission')}
                    </Link>
                </Button>
            </div>

            {/* List */}
            {missions.length === 0 ? (
                <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-6">
                    <p className="text-sm text-text dark:text-text-dark">{t('empty.title')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                        {t('empty.subtitle')}
                    </p>
                    <div className="mt-4">
                        <Button asChild size="sm" className="gap-1.5">
                            <Link href={`/new?type=mission`}>
                                <Plus className="w-3.5 h-3.5" />
                                {t('newMission')}
                            </Link>
                        </Button>
                    </div>
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
