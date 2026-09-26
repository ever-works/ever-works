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
import { ProviderRepositorySettings } from './ProviderRepositorySettings';
import { WebsiteConfigSettings } from './WebsiteConfigSettings';
import { ItemImportExportSettings } from './ItemImportExportSettings';
import { CommitterSettings } from './CommitterSettings';
import { ActivitySyncSettings } from './ActivitySyncSettings';
import { TaskIsolationSettings } from './TaskIsolationSettings';
import { QualityGatesSettings } from './QualityGatesSettings';
import { MergePolicySettings } from './MergePolicySettings';
import { ExternalRefsSettings } from './ExternalRefsSettings';
import { isRepositoryWorkKind } from '@ever-works/contracts';
interface SettingsFormProps {
    work: Work;
    user: AuthUser;
    initialRepositories: RepositoryStatus[];
    /**
     * APW-11 T17 (APW11-G13) — the App Launcher flag, resolved by the server
     * page and carried to `GeneralSettings`. Optional and defaulted to `false`:
     * a parent layout cannot pass props into a page (nor a page into a nested
     * layout), so the flag is re-read where it is used, and "not told" has to
     * mean **off** — a disabled deployment must render no setting at all.
     */
    appLauncherEnabled?: boolean;
}

export function SettingsForm({
    work,
    user,
    initialRepositories,
    appLauncherEnabled = false,
}: SettingsFormProps) {
    const t = useTranslations('dashboard.workDetail.settings');
    // A Repository Work wraps a repository the platform did not create: the
    // API refuses to flip its visibility or to run community-PR intake on
    // it, so the two cards are not offered rather than shown to fail.
    const wrapsExistingRepository = isRepositoryWorkKind(work.kind);

    return (
        <SettingsProvider work={work} user={user}>
            <div className="space-y-6">
                {/* Source Settings (if applicable) */}
                <SourceSettings />

                {/* General Settings — carries the App Launcher flag down to the
                    Work-level exposure setting (APW-11 T17). */}
                <GeneralSettings appLauncherEnabled={appLauncherEnabled} />

                {/* README Configuration */}
                <ReadmeConfiguration />

                {/* Repository Visibility Settings */}
                {!wrapsExistingRepository && (
                    <RepoVisibilitySettings initialRepositories={initialRepositories} />
                )}

                {/* Community PR Processing Settings */}
                <ProviderRepositorySettings />
                {!wrapsExistingRepository && <CommunityPrSettings />}

                {/* Wave 2 M7 — worktree-per-Task isolation */}
                <TaskIsolationSettings />

                {/* Wave 3 M6 — quality gates (acceptance-check defaults) */}
                <QualityGatesSettings />

                {/* Wave 3 D4 — merge policy (may agents land their own PRs) */}
                <MergePolicySettings />

                {/* Advanced Prompts Settings */}
                <AdvancedPromptsSettings workId={work.id} />

                {/* Website Configuration Settings */}
                <WebsiteConfigSettings workId={work.id} />

                {/* Item Import & Export Settings (EW-533) */}
                <ItemImportExportSettings workId={work.id} />

                {/* Activity Feed sync mode (EW-120 dual-mode) */}
                <ActivitySyncSettings />

                {/* Ingest routing claims — which external containers
                    (chat channels, tracker teams, doc databases, meetings)
                    route their events to this Work. */}
                <ExternalRefsSettings />

                {/* Git Committer Settings */}
                <CommitterSettings />

                {/* Danger Zone */}
                <DeleteComponent work={work} />
            </div>
        </SettingsProvider>
    );
}
