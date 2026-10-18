import { getTranslations } from 'next-intl/server';
import { Clock } from 'lucide-react';
import type { FleetHubTabId } from '../registry';
import { FLEET_PROGRAM_TRACKER_URL } from '../fleet-links';

type PlaceholderTab = Exclude<FleetHubTabId, 'overview' | 'computers'>;

/**
 * Fleet hub (FL-01, FR-4, spec §5.4) — what a hub tab shows until its epic
 * registers a panel: a sentence naming that epic and what the tab will be
 * for, with a link to the program tracker; or, when the epic shipped behind
 * a flag that is off here, "… switched off on this deployment". Never a
 * spinner, never an empty area. A `status` region (spec §5.13).
 */
export async function FleetHubTabPlaceholder({
    tab,
    epic,
    switchedOff,
}: {
    tab: PlaceholderTab;
    epic: string;
    switchedOff: boolean;
}) {
    const t = await getTranslations('fleet.placeholder');
    return (
        <div
            role="status"
            data-testid={`fleet-hub-placeholder-${tab}`}
            data-state={switchedOff ? 'switched-off' : 'not-shipped'}
            className="rounded-xl border border-dashed border-border dark:border-border-dark p-10 flex flex-col items-center text-center gap-3"
        >
            <div className="w-10 h-10 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark flex items-center justify-center">
                <Clock
                    className="w-5 h-5 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
            </div>
            {switchedOff ? (
                <p className="text-sm font-medium text-text dark:text-text-dark">
                    {t(`${tab}.switchedOff`)}
                </p>
            ) : (
                <>
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t(`${tab}.title`, { epic })}
                    </p>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-md">
                        {t(`${tab}.body`)}
                    </p>
                    <a
                        href={FLEET_PROGRAM_TRACKER_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-info hover:underline"
                        data-testid="fleet-hub-placeholder-tracker"
                    >
                        {t('tracker')}
                    </a>
                </>
            )}
        </div>
    );
}
