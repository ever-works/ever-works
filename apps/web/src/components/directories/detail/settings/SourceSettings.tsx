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

export function SourceSettings() {
    const t = useTranslations('dashboard.directoryDetail.settings');
    const { context } = useSettings();
    const { directory } = context;
    const router = useRouter();
    const [isSyncing, setIsSyncing] = useState(false);

    if (!directory.sourceRepository) {
        return null;
    }

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
