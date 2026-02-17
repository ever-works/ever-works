'use client';

import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { Loader2 } from 'lucide-react';
import { updateCommunityPrSettings } from '@/app/actions/dashboard/directories';
import { useRouter } from '@/i18n/navigation';
import { toast } from 'sonner';

export function CommunityPrSettings() {
    const t = useTranslations('dashboard.directoryDetail.settings');
    const { context } = useSettings();
    const { directory } = context;
    const router = useRouter();
    const [isUpdating, setIsUpdating] = useState(false);

    const handleToggleEnabled = async (enabled: boolean) => {
        setIsUpdating(true);
        try {
            const result = await updateCommunityPrSettings(directory.id, {
                communityPrEnabled: enabled,
            });

            if (result.success) {
                toast.success(enabled ? t('communityPrEnabled') : t('communityPrDisabled'));
                router.refresh();
            } else {
                toast.error(result.error || t('communityPrUpdateFailed'));
            }
        } catch {
            toast.error(t('communityPrUpdateFailed'));
        } finally {
            setIsUpdating(false);
        }
    };

    const handleToggleAutoClose = async (autoClose: boolean) => {
        setIsUpdating(true);
        try {
            const result = await updateCommunityPrSettings(directory.id, {
                communityPrAutoClose: autoClose,
            });

            if (result.success) {
                toast.success(t('communityPrSettingsUpdated'));
                router.refresh();
            } else {
                toast.error(result.error || t('communityPrUpdateFailed'));
            }
        } catch {
            toast.error(t('communityPrUpdateFailed'));
        } finally {
            setIsUpdating(false);
        }
    };

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                {t('communityPrProcessing')}
            </h3>

            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h4 className="text-sm font-medium text-text dark:text-text-dark">
                            {t('communityPrEnableLabel')}
                        </h4>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('communityPrEnableDescription')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {isUpdating && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
                        <Switch
                            checked={directory.communityPrEnabled}
                            onChange={handleToggleEnabled}
                            disabled={isUpdating}
                        />
                    </div>
                </div>

                {directory.communityPrEnabled && (
                    <div className="flex items-center justify-between pt-2 border-t border-card-border dark:border-card-border-dark">
                        <div>
                            <h4 className="text-sm font-medium text-text dark:text-text-dark">
                                {t('communityPrAutoCloseLabel')}
                            </h4>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('communityPrAutoCloseDescription')}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            {isUpdating && (
                                <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
                            )}
                            <Switch
                                checked={directory.communityPrAutoClose}
                                onChange={handleToggleAutoClose}
                                disabled={isUpdating}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
