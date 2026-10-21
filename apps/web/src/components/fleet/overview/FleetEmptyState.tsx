'use client';

import { useTranslations } from 'next-intl';
import { Monitor, Plus } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { fleetAddComputerHref } from '../hub/FleetAddComputerMenu';
import { FLEET_DOCS_URL } from '../fleet-links';

const PRIMARY =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors h-8 px-3 text-xs bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark';

/**
 * Fleet hub (FL-01, spec U1 / §5.3) — the hub with no computer yet: what a
 * computer is for, in two sentences, and the way to add one. The sidebar entry
 * stays so the path is discoverable; the runner pill stays hidden as today.
 */
export function FleetEmptyState() {
    const t = useTranslations('fleet.empty');
    return (
        <div
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-10 flex flex-col items-center text-center gap-3"
            data-testid="fleet-hub-empty"
        >
            <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Monitor className="w-5 h-5 text-primary" strokeWidth={1.5} aria-hidden="true" />
            </div>
            <h2 className="text-base font-semibold text-text dark:text-text-dark">{t('title')}</h2>
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-md">
                {t('body')}
            </p>
            <div className="flex items-center gap-3">
                <Link
                    href={fleetAddComputerHref('node')}
                    className={PRIMARY}
                    data-testid="fleet-hub-empty-add"
                >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('add')}
                </Link>
                <a
                    href={FLEET_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-info hover:underline"
                >
                    {t('howItWorks')}
                </a>
            </div>
        </div>
    );
}
