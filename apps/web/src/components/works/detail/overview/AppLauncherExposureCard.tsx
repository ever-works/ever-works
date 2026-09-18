'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { Work } from '@/lib/api/types-only';
import { AppLauncherExposureSetting } from '../settings/AppLauncherExposureSetting';

/**
 * APW-11 T17 — the **second** exposure surface, on the Work Overview (plan §7,
 * spec FR-59, ACC-11-45).
 *
 * ## Why this card exists
 *
 * The setting lives in the Work's General settings, and that page answers
 * `notFound()` unless `canAccessSettings(work.userRole)`
 * (`works/[id]/settings/page.tsx:31-33`) — MANAGER or higher
 * (`apps/web/src/lib/permissions.ts:70-71`). But the API grants the exposure
 * change to **EDITOR** (`ensureCanEdit`,
 * `packages/agent/src/services/work-ownership.service.ts:142-143`). An editor may
 * therefore make this choice and could not reach the page that offers it, and a
 * viewer could not see who can. So the Overview — which has no role gate — mounts
 * this card, and it renders the *same* control through the *same* action as the
 * settings row (ACC-11-45), wrapped in the same card chrome the other Overview
 * panels use.
 *
 * ## What the card itself owns
 *
 * The heading (`title`) and the description, which the setting renders for
 * itself on the settings surface and suppresses here (`showHeading={false}`) —
 * so no sentence is printed twice and the two surfaces stay word-for-word equal.
 * Everything else — the stored choice, the not-live and read-only states, the
 * save states, the reset — belongs to
 * {@link AppLauncherExposureSetting}, which both surfaces share.
 *
 * The page mounts it only when the launcher flag is on (`appLauncherEnabled`,
 * APW11-G13), and the card additionally renders nothing when the Work payload
 * carries no `appLauncher` projection at all.
 */
export interface AppLauncherExposureCardProps {
    work: Work;
}

export function AppLauncherExposureCard({ work }: AppLauncherExposureCardProps) {
    const t = useTranslations('dashboard.workDetail.settings.appLauncher');

    if (!work.appLauncher) return null;

    return (
        <section
            data-testid="app-launcher-exposure-card"
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-transparent',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
            </div>
            <div className="px-5 py-4 space-y-2">
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('description')}
                </p>
                <AppLauncherExposureSetting
                    workId={work.id}
                    kind={work.kind}
                    exposure={work.appLauncher}
                    userRole={work.userRole}
                    showHeading={false}
                />
            </div>
        </section>
    );
}
