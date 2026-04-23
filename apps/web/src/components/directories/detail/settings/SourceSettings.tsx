'use client';

import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { ExternalLink, Loader2 } from 'lucide-react';
import { updateDirectorySchedule } from '@/app/actions/dashboard/directories';
import { useRouter } from '@/i18n/navigation';
import { toast } from 'sonner';

const SOURCE_TYPE_LABELS: Record<string, string> = {
    data_repo: 'Data Repository',
    awesome_readme: 'Awesome README',
    link_existing: 'Linked Existing Repositories',
    works_config: 'works.yml',
};

export function SourceSettings() {
    const t = useTranslations('dashboard.directoryDetail.settings');
    const { context } = useSettings();
    const { directory } = context;
    const router = useRouter();
    const [isSyncing, setIsSyncing] = useState(false);

    if (!directory.sourceRepository) {
        return null;
    }

    const sourceRepository = directory.sourceRepository;
    const worksConfig = sourceRepository.worksConfig;
    const sourceTypeLabel =
        SOURCE_TYPE_LABELS[sourceRepository.type] || sourceRepository.type.replace(/_/g, ' ');
    const fallbackOwner = directory.owner || sourceRepository.owner;
    const websiteTarget =
        sourceRepository.relatedRepositories?.website?.owner &&
        sourceRepository.relatedRepositories?.website?.repo
            ? `${sourceRepository.relatedRepositories.website.owner}/${sourceRepository.relatedRepositories.website.repo}`
            : worksConfig?.websiteRepo || null;
    const appliedWebsiteRepo = sourceRepository.relatedRepositories?.website
        ? `${sourceRepository.relatedRepositories.website.owner || fallbackOwner}/${sourceRepository.relatedRepositories.website.repo}`
        : `${fallbackOwner}/${directory.slug}-website`;
    const appliedSchedule = directory.scheduledUpdatesEnabled
        ? directory.scheduledCadence || 'enabled'
        : 'disabled';

    const metadataRows = [
        { label: 'Source Type', value: sourceTypeLabel },
        worksConfig?.name ? { label: 'Config Name', value: worksConfig.name } : null,
        worksConfig?.initialPrompt
            ? {
                  label: 'Initial Prompt',
                  value: worksConfig.initialPrompt,
                  multiline: true,
              }
            : null,
        worksConfig?.model
            ? {
                  label: 'Model',
                  value: worksConfig.model,
                  hint: 'Imported from works.yml',
              }
            : null,
        worksConfig?.scheduleCadence
            ? {
                  label: 'Schedule',
                  value: worksConfig.scheduleCadence,
                  hint: `Applied: ${appliedSchedule}`,
              }
            : null,
        websiteTarget
            ? {
                  label: 'Website Repo',
                  value: websiteTarget,
                  hint: `Applied: ${appliedWebsiteRepo}`,
              }
            : null,
        typeof worksConfig?.additionalAgentsCount === 'number'
            ? {
                  label: 'Additional Agents',
                  value: String(worksConfig.additionalAgentsCount),
              }
            : null,
    ].filter(Boolean) as Array<{
        label: string;
        value: string;
        hint?: string;
        multiline?: boolean;
    }>;

    const handleSyncToggle = async (enabled: boolean) => {
        setIsSyncing(true);
        try {
            const result = await updateDirectorySchedule(directory.id, {
                enable: enabled,
            });

            if (result.success) {
                toast.success(enabled ? t('syncEnabled') : t('syncDisabled'));
                router.refresh();
            } else {
                toast.error(result.error || t('syncUpdateFailed'));
            }
        } catch (error) {
            toast.error(t('syncUpdateFailed'));
        } finally {
            setIsSyncing(false);
        }
    };

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('sourceSettings')}
                </h3>
            </div>

            <div className="px-5 py-4 space-y-4">
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                        {t('originalSource')}
                    </span>
                    <a
                        href={directory.sourceRepository.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                        {directory.sourceRepository.owner}/{directory.sourceRepository.repo}
                        <ExternalLink className="h-3 w-3" />
                    </a>
                </div>

                {metadataRows.length > 0 && (
                    <div className="space-y-3 pt-2">
                        {metadataRows.map((row) => (
                            <div key={row.label} className="flex flex-col gap-1">
                                <span className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                    {row.label}
                                </span>
                                {row.multiline ? (
                                    <div className="rounded-md bg-surface px-3 py-2 text-sm text-text dark:bg-surface-dark dark:text-text-dark">
                                        {row.value}
                                    </div>
                                ) : (
                                    <span className="text-sm text-text dark:text-text-dark">
                                        {row.value}
                                    </span>
                                )}
                                {row.hint && (
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {row.hint}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                <div className="flex items-center justify-between pt-2">
                    <div>
                        <h4 className="text-xs font-medium text-text dark:text-text-dark">
                            {t('syncEnabled')}
                        </h4>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('syncDescription')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {isSyncing && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
                        <Switch
                            checked={directory.scheduledUpdatesEnabled}
                            onChange={handleSyncToggle}
                            disabled={isSyncing}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
