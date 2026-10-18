'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { FleetComputerTabProps } from '../../registry';
import { PolicyFamiliesEditor } from '../PolicyFamiliesEditor';
import { ComputerMachineSettings } from '../ComputerMachineSettings';

/**
 * Fleet hub (FL-01, spec §5.10) — a computer's Settings tab, FL-01's part:
 * who can do what on it (the per-family policy) and, for the owner, the
 * machine's own settings (capability tags, limits, cost ceiling, lifecycle,
 * credential) — the Computers tab's node panel, mounted unchanged. `machine`
 * carries what the credential hand-over needs; the page passes it (see
 * `SettingsTabServer`), and without it the tab links to the Computers tab.
 */
export default function SettingsTab({
    node,
    machine,
}: FleetComputerTabProps & {
    machine?: { apiBaseUrl: string; desktopDownloadUrl: string; nodeDownloadUrl: string };
}) {
    const t = useTranslations('fleet.computer.settings');
    const isOwner = node.viewerRole === undefined || node.viewerRole === 'owner';
    return (
        <div className="space-y-8" data-testid="fleet-computer-settings">
            <PolicyFamiliesEditor node={node} />
            {isOwner && machine && <ComputerMachineSettings node={node} {...machine} />}
            {isOwner && !machine && (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('moreSettings')}{' '}
                    <Link
                        href={ROUTES.DASHBOARD_FLEET_COMPUTERS}
                        className="text-info hover:underline"
                    >
                        {t('moreSettingsLink')}
                    </Link>
                </p>
            )}
        </div>
    );
}
