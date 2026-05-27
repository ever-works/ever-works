'use client';

import { useState, useTransition } from 'react';
import { Target } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { PromptComposer } from '@/components/common/PromptComposer';
import { PageHeader } from '@/components/common/PageHeader';
import { createMissionAction } from '@/app/actions/dashboard/missions';
import { MissionCard } from './MissionCard';
import type { Mission } from '@/lib/api/missions';

/**
 * Phase 6 PR Q + UI polish — Missions catalog list client.
 *
 * Spec: simple grid of MissionCards with a quick-add composer at
 * the top so the user can describe a new Mission inline (mirrors
 * `/ideas`, see [IdeasPageClient.tsx]). The composer matches the
 * marketing site's landing prompt (typewriter placeholder, arrow
 * submit inside the input) so first-time and returning users see
 * the same shape.
 *
 * The sidebar's "+ New" still routes to `/new?type=mission` for
 * the chip-aware unified entry point — this page hosts the
 * Mission-only composer.
 */

const MISSION_PLACEHOLDERS: ReadonlyArray<string> = [
    'e.g. "Curate the best AI coding assistants and refresh the list weekly"',
    'e.g. "Maintain a directory of remote-friendly climate-tech companies"',
    'e.g. "Track new MCP servers shipped each week and tag the standout ones"',
    'e.g. "Publish a fresh investor-targeted comparison of OSS observability tools every month"',
    'e.g. "Keep an awesome-list of TypeScript ESLint rules in sync with the latest releases"',
    'e.g. "Spin up a niche directory of Tailwind component libraries and refresh metadata"',
];

export function MissionsList({ missions }: { missions: Mission[] }) {
    const t = useTranslations('dashboard.missionsPage');
    const router = useRouter();
    const [draft, setDraft] = useState('');
    const [submitting, startSubmit] = useTransition();

    const submit = () => {
        const description = draft.trim();
        if (description.length < 10) {
            toast.error(t('quickAdd.minLength'));
            return;
        }
        startSubmit(async () => {
            try {
                const mission = await createMissionAction({
                    description,
                    type: 'one-shot',
                });
                toast.success(t('quickAdd.created'));
                setDraft('');
                // Route into the new Mission's detail page — this is
                // the same destination `/new?type=mission` lands on,
                // so the user gets the next-step affordances (tune
                // cadence, cap, auto-build) immediately.
                router.push(ROUTES.DASHBOARD_MISSION(mission.id));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('quickAdd.error'));
            }
        });
    };

    return (
        <div className="w-full overflow-auto p-6 max-w-screen-2xl mx-auto">
            {/* Header */}
            <PageHeader
                icon={Target}
                title={t('title')}
                subtitle={t('subtitle')}
                tone="warning"
            />

            {/* Quick-add composer — modeled on the marketing site's
                landing prompt. Used by both empty and populated
                states so the entry point doesn't move around as the
                user's catalog grows. */}
            <div className="mb-6">
                <label
                    htmlFor="missions-quick-add"
                    className="block text-xs font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark mb-2"
                >
                    {t('quickAdd.label')}
                </label>
                <PromptComposer
                    inputId="missions-quick-add"
                    value={draft}
                    onChange={setDraft}
                    onSubmit={submit}
                    submitting={submitting}
                    placeholderExamples={MISSION_PLACEHOLDERS}
                    ariaLabel={t('quickAdd.label')}
                    submitTitle={t('quickAdd.submitTitle')}
                    testId="missions-quick-add"
                />
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
