'use client';

import { Directory } from '@/lib/api/types-only';
import { useTranslations } from 'next-intl';
import { AuthUser } from '@/lib/auth';
import { DeleteComponent } from './DeleteComponent';
import { GeneralSettings } from './GeneralSettings';
import { SettingsProvider } from './SettingsContext';
import { ReadmeConfiguration } from './ReadmeConfiguration';

interface SettingsFormProps {
    directory: Directory;
    user: AuthUser;
}

export function SettingsForm({ directory, user }: SettingsFormProps) {
    const t = useTranslations('dashboard.directoryDetail.settings');

    return (
        <SettingsProvider directory={directory} user={user}>
            <div className="space-y-6">
                {/* General Settings */}
                <GeneralSettings />

                {/* README Configuration */}
                <ReadmeConfiguration />

                {/* Danger Zone */}
                <DeleteComponent directory={directory} />
            </div>
        </SettingsProvider>
    );
}
