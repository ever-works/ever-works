'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@/components/ui/accordion';
import { toast } from 'sonner';
import { updateWebsiteSettings } from '@/app/actions/dashboard/directories';
import { useWebsiteSettingsForm, WebsiteSettingsFormContent } from '../shared/WebsiteSettingsForm';

interface WebsiteConfigSettingsProps {
    directoryId: string;
}

export function WebsiteConfigSettings({ directoryId }: WebsiteConfigSettingsProps) {
    const t = useTranslations('dashboard.directoryDetail.settings.websiteConfig');

    const [isExpanded, setIsExpanded] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const {
        isLoading,
        hasLoaded,
        formData,
        setFormData,
        loadSettings,
        updateSettings,
        updateHeaderSettings,
        updateHomepageSettings,
        updateFooterSettings,
        addMenuItem,
        updateMenuItem,
        removeMenuItem,
    } = useWebsiteSettingsForm(directoryId, t('loadFailed'));

    useEffect(() => {
        if (isExpanded && !hasLoaded) {
            loadSettings();
        }
    }, [isExpanded, hasLoaded, loadSettings]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const result = await updateWebsiteSettings(directoryId, {
                company_name: formData.company_name,
                company_website: formData.company_website,
                ...formData.settings,
                custom_menu: formData.custom_menu,
            });

            if (result.success) {
                toast.success(t('saveSuccess'));
            } else {
                toast.error(result.error || t('saveFailed'));
            }
        } catch (error) {
            console.error('Failed to save website settings:', error);
            toast.error(t('saveFailed'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleAccordionChange = (value: string) => {
        const nowExpanded = value === 'website-config';
        setIsExpanded(nowExpanded);
    };

    return (
        <Accordion type="single" collapsible onValueChange={handleAccordionChange}>
            <AccordionItem
                value="website-config"
                className={cn(
                    'rounded-lg border overflow-hidden',
                    'bg-card dark:bg-card-primary-dark/30',
                    'border-card-border dark:border-border-secondary-dark',
                )}
            >
                <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-surface/50 dark:hover:bg-surface-dark/50">
                    <div className="text-left">
                        <span className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </span>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 font-normal">
                            {t('subtitle')}
                        </p>
                    </div>
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-4 pt-2">
                    {isLoading ? (
                        <div className="flex justify-center py-12">
                            <Loader2 className="animate-spin h-8 w-8 text-primary" />
                        </div>
                    ) : (
                        <>
                            <WebsiteSettingsFormContent
                                formData={formData}
                                setFormData={setFormData}
                                updateSettings={updateSettings}
                                updateHeaderSettings={updateHeaderSettings}
                                updateHomepageSettings={updateHomepageSettings}
                                updateFooterSettings={updateFooterSettings}
                                addMenuItem={addMenuItem}
                                updateMenuItem={updateMenuItem}
                                removeMenuItem={removeMenuItem}
                                tSettings={t as (key: string) => string}
                                variant="full"
                            />

                            {/* Save Button */}
                            <div className="flex justify-end pt-6">
                                <Button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={isSaving}
                                    loading={isSaving}
                                    className='text-sm'
                                >
                                    {t('save')}
                                </Button>
                            </div>
                        </>
                    )}
                </AccordionContent>
            </AccordionItem>
        </Accordion>
    );
}
