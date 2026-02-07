'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DirectoryPlugin } from '@/lib/api/plugins';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogDescription,
    DialogFooter,
    DialogClose,
} from '@/components/ui/dialog';
import { DialogTitle } from '@headlessui/react';
import { Button } from '@/components/ui/button';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { PluginSettingsFormFields } from '@/components/plugins/PluginSettingsFormFields';
import { InheritedValueHint } from './InheritedValueHint';
import { usePluginSettings } from '@/lib/hooks/use-plugin-settings';
import { updateDirectoryPluginSettings } from '@/app/actions/plugins';
import { RotateCcw, Save, Check } from 'lucide-react';

interface DirectoryPluginSettingsModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    directoryId: string;
    plugin: DirectoryPlugin;
}

export function DirectoryPluginSettingsModal({
    open,
    onOpenChange,
    directoryId,
    plugin,
}: DirectoryPluginSettingsModalProps) {
    const t = useTranslations('dashboard.directoryPlugins');
    const router = useRouter();
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [isResetting, setIsResetting] = useState(false);

    const onSave = useCallback(
        async (data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        }) => {
            await updateDirectoryPluginSettings(directoryId, plugin.pluginId, data);
        },
        [directoryId, plugin.pluginId],
    );

    const {
        hasChanges,
        isSaving,
        saveSuccess,
        validationError,
        visibleProperties,
        handleFieldChange,
        handleSave,
        getFieldValue,
    } = usePluginSettings({
        schema: plugin.settingsSchema,
        initialSettings: plugin.directorySettings || {},
        scopes: ['global', 'directory'],
        onSave,
        fallbackSettings: plugin.settings,
    });

    const handleSaveAndClose = async () => {
        await handleSave();
        // Close only if save was successful (no validation error will be set)
        // We rely on saveSuccess being set after a successful save
    };

    const handleReset = async () => {
        const keysToReset: Record<string, null> = {};
        if (plugin.directorySettings) {
            for (const key of Object.keys(plugin.directorySettings)) {
                keysToReset[key] = null;
            }
        }

        if (Object.keys(keysToReset).length === 0) {
            setShowResetConfirm(false);
            return;
        }

        setIsResetting(true);
        try {
            await updateDirectoryPluginSettings(directoryId, plugin.pluginId, {
                settings: keysToReset,
            });
            router.refresh();
            setShowResetConfirm(false);
            onOpenChange(false);
        } catch (error) {
            console.error('Failed to reset settings:', error);
        } finally {
            setIsResetting(false);
        }
    };

    const hasDirectoryOverrides =
        plugin.directorySettings && Object.keys(plugin.directorySettings).length > 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogClose onClose={() => onOpenChange(false)} />
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <PluginIcon icon={plugin.icon} name={plugin.name} size={40} />
                        <div>
                            <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                                {plugin.name}
                            </DialogTitle>
                            <DialogDescription>
                                v{plugin.version} &middot; {t('settingsModalTitle')}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('settingsModalDescription')}
                </p>

                <PluginSettingsFormFields
                    visibleProperties={visibleProperties}
                    getFieldValue={getFieldValue}
                    handleFieldChange={handleFieldChange}
                    settingsSchema={plugin.settingsSchema}
                    pluginId={plugin.pluginId}
                    validationError={validationError}
                    renderFieldExtra={(key, propSchema) => (
                        <InheritedValueHint
                            value={plugin.settings?.[key]}
                            isSecret={propSchema.secret || false}
                        />
                    )}
                />

                {/* Reset confirmation */}
                {showResetConfirm && (
                    <div className="mt-4 p-3 rounded-lg bg-warning/10 border border-warning/20">
                        <p className="text-sm text-text dark:text-text-dark mb-2">
                            {t('resetConfirm')}
                        </p>
                        <div className="flex gap-2">
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setShowResetConfirm(false)}
                                disabled={isResetting}
                            >
                                {t('cancel')}
                            </Button>
                            <Button
                                size="sm"
                                variant="primary"
                                onClick={handleReset}
                                loading={isResetting}
                                disabled={isResetting}
                            >
                                {t('resetToDefaults')}
                            </Button>
                        </div>
                    </div>
                )}

                <DialogFooter className="flex justify-between items-center">
                    <div>
                        {hasDirectoryOverrides && !showResetConfirm && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setShowResetConfirm(true)}
                            >
                                <RotateCcw className="w-3.5 h-3.5 mr-1" />
                                {t('resetToDefaults')}
                            </Button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {saveSuccess && (
                            <span className="inline-flex items-center gap-1 text-sm text-success">
                                <Check className="w-4 h-4" />
                                {t('saved')}
                            </span>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                            {t('cancel')}
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleSaveAndClose}
                            disabled={!hasChanges || isSaving}
                            loading={isSaving}
                        >
                            <Save className="w-3.5 h-3.5 mr-1" />
                            {t('save')}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
