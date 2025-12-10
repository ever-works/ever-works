import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';

export function ReadmeConfiguration() {
    const t = useTranslations('dashboard.directoryDetail.settings');

    const { context, handleUpdate, isPending } = useSettings();
    const { formData, setFormData } = context;

    return (
        <div
            className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                {t('readmeConfiguration')}
            </h3>

            <div className="space-y-4">
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
        </div>
    );
}
