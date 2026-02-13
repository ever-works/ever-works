'use client';

import { useEffect } from 'react';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
    useWebsiteSettingsForm,
    WebsiteSettingsFormContent,
    type WebsiteSettingsFormData,
} from '../shared/WebsiteSettingsForm';

export type DeployConfigData = WebsiteSettingsFormData;

interface DeployConfigDialogProps {
    open: boolean;
    directoryId: string;
    isSubmitting?: boolean;
    onConfirm: (settings: DeployConfigData | null) => void;
    onCancel: () => void;
}

export function DeployConfigDialog({
    open,
    directoryId,
    isSubmitting = false,
    onConfirm,
    onCancel,
}: DeployConfigDialogProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy.form.configDialog');
    const tSettings = useTranslations('dashboard.directoryDetail.settings.websiteConfig');

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
    } = useWebsiteSettingsForm(directoryId, t('loadFailed'));

    useEffect(() => {
        if (open && !hasLoaded) {
            loadSettings();
        }
    }, [open, hasLoaded, loadSettings]);

    const handleSaveAndDeploy = () => onConfirm(formData);
    const handleSkipAndDeploy = () => onConfirm(null);
    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) onCancel();
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogClose onClose={onCancel} />
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                {isLoading ? (
                    <div className="flex justify-center py-16">
                        <Loader2 className="animate-spin h-8 w-8 text-primary" />
                    </div>
                ) : (
                    <WebsiteSettingsFormContent
                        formData={formData}
                        setFormData={setFormData}
                        updateSettings={updateSettings}
                        updateHeaderSettings={updateHeaderSettings}
                        updateHomepageSettings={updateHomepageSettings}
                        updateFooterSettings={updateFooterSettings}
                        tSettings={tSettings as (key: string) => string}
                        variant="compact"
                    />
                )}

                <DialogFooter className="flex-col sm:flex-row gap-2 pt-4 border-t border-border dark:border-border-dark">
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={onCancel}
                        disabled={isSubmitting}
                        className="sm:mr-auto"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={handleSkipAndDeploy}
                        disabled={isSubmitting || isLoading}
                    >
                        {t('skipAndDeploy')}
                    </Button>
                    <Button
                        type="button"
                        onClick={handleSaveAndDeploy}
                        disabled={isSubmitting || isLoading}
                    >
                        {isSubmitting ? (
                            <span className="flex items-center gap-2">
                                <Loader2 className="animate-spin h-4 w-4" />
                                {t('saveAndDeploy')}
                            </span>
                        ) : (
                            t('saveAndDeploy')
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
