import { pluginsAPI, type SettingsMenuResponse } from '@/lib/api/plugins';
import { isFleetEnabled } from '@/lib/fleet-flags';
import { SettingsLayoutClient } from './settings-layout-client';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
    let settingsMenu: SettingsMenuResponse | null = null;

    try {
        settingsMenu = await pluginsAPI.listForSettingsMenu();
    } catch (error) {
        // If the API fails, we'll just show static tabs without plugin categories
        console.error('Failed to fetch settings menu:', error);
    }

    // `FLEET_ENABLED` is read here, on the server, and passed down: the
    // nav is a client component and must not read a non-public env var
    // itself (it would be `undefined` in the browser and the tab would
    // reappear). Same switch the API and the Fleet page enforce, so a
    // disabled deployment has no entry point AND no route.
    return (
        <SettingsLayoutClient settingsMenu={settingsMenu} fleetEnabled={isFleetEnabled()}>
            {children}
        </SettingsLayoutClient>
    );
}
