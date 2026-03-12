import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@/components/ui/accordion';

export function ReadmeConfiguration() {
    const t = useTranslations('dashboard.directoryDetail.settings');

    const { context, handleUpdate, isPending } = useSettings();
    const { formData, setFormData } = context;

    return (
        <Accordion type="single" collapsible>
            <AccordionItem
                value="readme"
                className={cn(
                    'rounded-lg border overflow-hidden',
                    'bg-card dark:bg-card-primary-dark/30',
                    'border-card-border dark:border-card-border-dark',
                )}
            >
                <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-surface/50 dark:hover:bg-surface-dark/50">
                    <span className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('readmeConfiguration')}
                    </span>
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-4 pt-2">
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
                </AccordionContent>
            </AccordionItem>
        </Accordion>
    );
}
