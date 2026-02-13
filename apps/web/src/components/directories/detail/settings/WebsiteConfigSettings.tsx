'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ChevronDownIcon, ChevronUpIcon, Loader2 } from 'lucide-react';
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

    return (
        <div
            className={cn(
                'rounded-lg border',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            {/* Collapsible Header */}
            <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-6 flex items-center justify-between text-left hover:bg-muted/50 dark:hover:bg-muted-dark/50 transition-colors rounded-lg"
            >
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                {isExpanded ? (
                    <ChevronUpIcon className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                ) : (
                    <ChevronDownIcon className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                )}
            </button>

            {/* Expandable Content */}
            {isExpanded && (
                <div className="px-6 pb-6">
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
                                >
                                    {t('save')}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
