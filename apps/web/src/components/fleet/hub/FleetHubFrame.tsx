import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Server, Settings } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { fleetAPI, type FleetKillSwitchState } from '@/lib/api/fleet';
import { PageHeader } from '@/components/common/PageHeader';
import { FleetKillSwitchBanner } from '@/components/settings/FleetKillSwitchBanner';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import { FLEET_FEATURE_FLAGS, type FleetHubTabId } from '../registry';
import { FleetAddComputerMenu } from './FleetAddComputerMenu';
import { FleetHubTabs } from './FleetHubTabs';

const SECONDARY =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors h-8 px-3 text-xs border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark';

/**
 * Fleet hub (FL-01, spec §5.2) — the frame every hub tab renders in: the page
 * header (Fleet · Add computer ▾ · Fleet settings), the kill-switch banner when
 * the fleet is stopped (FR-14), and the six-tab strip. Each hub page renders
 * it with its own tab active, the way each Teams hub page renders its strip,
 * so the computer page (`/fleet/computers/[id]`) can have its own header and
 * tab strip instead.
 *
 * The kill-switch read is best-effort: a failed read renders the banner's
 * "could not verify" variant, never a broken page.
 */
export async function FleetHubFrame({
    active,
    children,
}: {
    active: FleetHubTabId;
    children: ReactNode;
}) {
    const t = await getTranslations('fleet.hub');
    const flags = readFleetFeatureFlags(FLEET_FEATURE_FLAGS);
    let killSwitch: FleetKillSwitchState | null = null;
    let killSwitchError: string | null = null;
    try {
        killSwitch = await fleetAPI.killSwitchState();
    } catch (error) {
        killSwitchError = error instanceof Error ? error.message : 'Failed to read the stop flag';
    }

    return (
        <div className="w-full space-y-0" data-testid="fleet-hub" data-tab={active}>
            <PageHeader
                icon={Server}
                title={t('title')}
                subtitle={t('subtitle')}
                actions={
                    <>
                        <FleetAddComputerMenu flags={flags} />
                        <Link
                            href={ROUTES.DASHBOARD_SETTINGS_FLEET}
                            className={SECONDARY}
                            data-testid="fleet-hub-settings-link"
                        >
                            <Settings className="w-3.5 h-3.5" aria-hidden="true" />
                            {t('settings')}
                        </Link>
                    </>
                }
            />
            <div className="space-y-2 mb-4">
                <FleetKillSwitchBanner initial={killSwitch} initialError={killSwitchError} />
                {killSwitch?.stopped && (
                    // Spec U9: the hub's own registry acts keep working while live
                    // actions are refused — say so beside the stop banner.
                    <p
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-hub-kill-switch-note"
                    >
                        {t('killSwitchNote')}
                    </p>
                )}
            </div>
            <FleetHubTabs active={active} />
            <div id="fleet-hub-panel" role="tabpanel" aria-labelledby={`fleet-hub-tab-${active}`}>
                {children}
            </div>
        </div>
    );
}
