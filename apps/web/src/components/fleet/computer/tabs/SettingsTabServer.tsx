import 'server-only';
import { resolveFleetDownloadUrls, resolvePublicApiBaseUrl } from '@/lib/fleet-flags';
import type { FleetComputerTabProps } from '../../registry';
import SettingsTab from './SettingsTab';

/**
 * Fleet hub (FL-01, T-24) — the Settings tab as the page renders it: the
 * deployment's public API base and node downloads are read here, on the
 * server (exactly as the Computers tab reads them), so the machine settings'
 * credential rotation can hand over its one-time token with the ready-to-run
 * command.
 */
export default function SettingsTabServer({ node, flags }: FleetComputerTabProps) {
    const downloads = resolveFleetDownloadUrls();
    return (
        <SettingsTab
            node={node}
            flags={flags}
            machine={{
                apiBaseUrl: resolvePublicApiBaseUrl(),
                desktopDownloadUrl: downloads.desktop,
                nodeDownloadUrl: downloads.node,
            }}
        />
    );
}
