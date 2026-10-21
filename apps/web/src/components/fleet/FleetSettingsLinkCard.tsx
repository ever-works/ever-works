'use client';

import { ArrowRight, Server } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/**
 * Fleet hub (FL-01, FR-11, spec §5.7) — the card Settings → Fleet shows where
 * the machine table used to be once the hub is on: the computers moved, the
 * policies stayed. Rendered only with the hub flag on; with it off Settings →
 * Fleet is exactly what it was.
 */
export function FleetSettingsLinkCard() {
    const t = useTranslations('fleet.settingsLink');
    return (
        <section
            className="rounded-lg border border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 p-4 flex items-start gap-3"
            data-testid="fleet-settings-hub-link"
            aria-labelledby="fleet-settings-hub-link-title"
        >
            <Server
                className="w-5 h-5 mt-0.5 shrink-0 text-text-muted dark:text-text-muted-dark"
                aria-hidden="true"
            />
            <div className="space-y-1 min-w-0">
                <h3
                    id="fleet-settings-hub-link-title"
                    className="text-sm font-semibold text-text dark:text-text-dark"
                >
                    {t('title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('body')}</p>
                <Link
                    href={ROUTES.DASHBOARD_FLEET_COMPUTERS}
                    className="inline-flex items-center gap-1 text-sm font-medium text-info hover:underline"
                    data-testid="fleet-settings-hub-link-cta"
                >
                    {t('cta')}
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
            </div>
        </section>
    );
}
