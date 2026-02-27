import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';

export function ReadmeConfiguration() {
    const t = useTranslations('dashboard.directoryDetail.settings');

    const { context, handleUpdate, isPending } = useSettings();
    const { formData, setFormData } = context;

    const [isExpanded, setIsExpanded] = useState(false);

    return (
        <div
            className={cn(
                'rounded-lg border',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-6 flex items-center justify-between text-left hover:bg-muted/50 dark:hover:bg-muted-dark/50 transition-colors rounded-lg"
            >
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    {t('readmeConfiguration')}
                </h3>
                {isExpanded ? (
                    <ChevronUpIcon className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                ) : (
                    <ChevronDownIcon className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                )}
            </button>

            {isExpanded && (
                <div className="px-6 pb-6 space-y-4">
                    <div className="space-y-3">
                        <AutoResizeTextarea
                            label={t('customHeader')}
                            value={formData.readmeConfig?.header || ''}
                            onChange={(e) =>
                                setFormData({
                                    ...formData,
                                    readmeConfig: {
                                        ...formData.readmeConfig,
                                        header: e.target.value,
                                    },
                                })
                            }
                            placeholder={t('customHeaderPlaceholder')}
                            rows={3}
                            variant="form"
                            minRows={3}
                            maxHeight={320}
                        />
                        <Checkbox
                            checked={formData.readmeConfig?.overwriteDefaultHeader || false}
                            onChange={(e) =>
                                setFormData({
                                    ...formData,
                                    readmeConfig: {
                                        ...formData.readmeConfig,
                                        overwriteDefaultHeader: e.target.checked,
                                    },
                                })
                            }
                            label={t('overwriteDefaultHeader')}
                            variant="form"
                        />
                    </div>

                    <div className="space-y-3">
                        <AutoResizeTextarea
                            label={t('customFooter')}
                            value={formData.readmeConfig?.footer || ''}
                            onChange={(e) =>
                                setFormData({
                                    ...formData,
                                    readmeConfig: {
                                        ...formData.readmeConfig,
                                        footer: e.target.value,
                                    },
                                })
                            }
                            placeholder={t('customFooterPlaceholder')}
                            rows={3}
                            variant="form"
                            minRows={3}
                            maxHeight={320}
                        />
                        <Checkbox
                            checked={formData.readmeConfig?.overwriteDefaultFooter || false}
                            onChange={(e) =>
                                setFormData({
                                    ...formData,
                                    readmeConfig: {
                                        ...formData.readmeConfig,
                                        overwriteDefaultFooter: e.target.checked,
                                    },
                                })
                            }
                            label={t('overwriteDefaultFooter')}
                            variant="form"
                        />
                    </div>

                    <Button
                        type="button"
                        onClick={handleUpdate}
                        disabled={isPending}
                        loading={isPending}
                        variant="secondary"
                    >
                        {t('updateReadme')}
                    </Button>
                </div>
            )}
        </div>
    );
}
