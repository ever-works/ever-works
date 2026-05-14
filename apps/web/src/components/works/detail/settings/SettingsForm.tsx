'use client';

import { Work, RepositoryStatus } from '@/lib/api/types-only';
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
import { ItemImportExportSettings } from './ItemImportExportSettings';
import { CommitterSettings } from './CommitterSettings';
import { ActivitySyncSettings } from './ActivitySyncSettings';
interface SettingsFormProps {
    work: Work;
    user: AuthUser;
    initialRepositories: RepositoryStatus[];
}

export function SettingsForm({ work, user, initialRepositories }: SettingsFormProps) {
    const t = useTranslations('dashboard.workDetail.settings');

    return (
        <SettingsProvider work={work} user={user}>
            <div className="space-y-6">
                {/* Source Settings (if applicable) */}
                <SourceSettings />

                {/* General Settings */}
                <GeneralSettings />

                {/* README Configuration */}
                <ReadmeConfiguration />

                {/* Repository Visibility Settings */}
                <RepoVisibilitySettings initialRepositories={initialRepositories} />

                {/* Community PR Processing Settings */}
                <CommunityPrSettings />

                {/* Advanced Prompts Settings */}
                <AdvancedPromptsSettings workId={work.id} />

                {/* Website Configuration Settings */}
                <WebsiteConfigSettings workId={work.id} />

                {/* Item Import & Export Settings (EW-533) */}
                <ItemImportExportSettings workId={work.id} />

                {/* Activity Feed sync mode (EW-120 dual-mode) */}
                <ActivitySyncSettings />

                {/* Git Committer Settings */}
                <CommitterSettings />

                {/* Danger Zone */}
                <DeleteComponent work={work} />
            </div>
        </SettingsProvider>
    );
}
