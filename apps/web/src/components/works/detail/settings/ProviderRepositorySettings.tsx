'use client';

import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { Loader2 } from 'lucide-react';
import { updateProviderRepositorySettings } from '@/app/actions/dashboard/works';
import { useRouter } from '@/i18n/navigation';
import { toast } from 'sonner';
import { getWorkCapabilities } from '@ever-works/contracts';
import { formatGitProviderName } from '@/lib/utils/git-provider';

/**
 * Opt out of generating the "{provider} Repository".
 *
 * That repository is the browsable, AI-generated view of a Work published to
 * GitHub/GitLab — it is never deployed; people read it on the host. Not
 * every Work wants one, and until now there was no way to say so.
 *
 * The card hides entirely for a Work whose kind never provisions that
 * repository: offering a switch that cannot change anything is worse than
 * offering nothing.
 */
export function ProviderRepositorySettings() {
    const t = useTranslations('dashboard.workDetail.settings');
    const { context } = useSettings();
    const { work } = context;
    const router = useRouter();
    const [isUpdating, setIsUpdating] = useState(false);

    const providerName = formatGitProviderName(work.gitProvider);

    if (!getWorkCapabilities(work.kind).repos.work) {
        return null;
    }

    // Rows written before the column existed come back undefined; absent
    // means enabled, matching the server-side resolution.
    const enabled = work.providerRepositoryEnabled ?? true;

    const handleToggle = async (next: boolean) => {
        setIsUpdating(true);
        try {
            const result = await updateProviderRepositorySettings(work.id, {
                providerRepositoryEnabled: next,
            });

            if (result.success) {
                toast.success(
                    next
                        ? t('providerRepoEnabled', { provider: providerName })
                        : t('providerRepoDisabled', { provider: providerName }),
                );
                router.refresh();
            } else {
                toast.error(result.error || t('providerRepoUpdateFailed'));
            }
        } catch {
            toast.error(t('providerRepoUpdateFailed'));
        } finally {
            setIsUpdating(false);
        }
    };

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
            data-testid="provider-repository-settings"
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('providerRepoTitle', { provider: providerName })}
                </h3>
            </div>

            <div className="px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        <h4 className="text-xs font-medium text-text dark:text-text-dark">
                            {t('providerRepoEnableLabel', { provider: providerName })}
                        </h4>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('providerRepoEnableDescription', { provider: providerName })}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {isUpdating && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
                        <Switch
                            checked={enabled}
                            onChange={handleToggle}
                            disabled={isUpdating}
                            className="mt-0"
                            data-testid="provider-repository-toggle"
                        />
                    </div>
                </div>

                {!enabled && (
                    <p className="mt-3 pt-3 border-t border-card-border dark:border-border-secondary-dark text-xs text-text-muted dark:text-text-muted-dark">
                        {t('providerRepoDisabledNote', { provider: providerName })}
                    </p>
                )}
            </div>
        </div>
    );
}
