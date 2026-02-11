import { pluginsAPI, type SettingsMenuResponse } from '@/lib/api/plugins';
import { SettingsLayoutClient } from './settings-layout-client';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
    let settingsMenu: SettingsMenuResponse | null = null;

    try {
        settingsMenu = await pluginsAPI.listForSettingsMenu();
    } catch (error) {
        // If the API fails, we'll just show static tabs without plugin categories
        console.error('Failed to fetch settings menu:', error);
    }

    return <SettingsLayoutClient settingsMenu={settingsMenu}>{children}</SettingsLayoutClient>;
}
