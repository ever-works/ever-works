'use client';

import { Directory, RepositoryStatus } from '@/lib/api/types-only';
import { useTranslations } from 'next-intl';
import { AuthUser } from '@/lib/auth';
import { DeleteComponent } from './DeleteComponent';
import { GeneralSettings } from './GeneralSettings';
import { SourceSettings } from './SourceSettings';
import { SettingsProvider } from './SettingsContext';
import { ReadmeConfiguration } from './ReadmeConfiguration';
import { RepoVisibilitySettings } from './RepoVisibilitySettings';
import { AdvancedPromptsSettings } from './AdvancedPromptsSettings';
import { CommunityPrSettings } from './CommunityPrSettings';
import { WebsiteConfigSettings } from './WebsiteConfigSettings';
interface SettingsFormProps {
    directory: Directory;
    user: AuthUser;
    initialRepositories: RepositoryStatus[];
}

export function SettingsForm({ directory, user, initialRepositories }: SettingsFormProps) {
    const t = useTranslations('dashboard.directoryDetail.settings');

    return (
        <SettingsProvider directory={directory} user={user}>
            <div className="space-y-6">
                {/* Source Settings (if applicable) */}
                <SourceSettings />

                {/* General Settings */}
                <GeneralSettings />

                {/* README Configuration */}
                <ReadmeConfiguration />

                {/* Repository Visibility Settings */}
                <RepoVisibilitySettings initialRepositories={initialRepositories} />

                {/* Advanced Prompts Settings */}
                <AdvancedPromptsSettings directoryId={directory.id} />

                {/* Community PR Processing Settings */}
                <CommunityPrSettings />

                {/* Website Configuration Settings */}
                <WebsiteConfigSettings directoryId={directory.id} />

                {/* Danger Zone */}
                <DeleteComponent directory={directory} />
            </div>
        </SettingsProvider>
    );
}
