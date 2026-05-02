'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { WorkPlugin } from '@/lib/api/plugins';
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
import { updateWorkPluginSettings } from '@/app/actions/plugins';
import { RotateCcw, Save, Check } from 'lucide-react';

interface WorkPluginSettingsModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workId: string;
    plugin: WorkPlugin;
}

export function WorkPluginSettingsModal({
    open,
    onOpenChange,
    workId,
    plugin,
}: WorkPluginSettingsModalProps) {
    const t = useTranslations('dashboard.workPlugins');
    const router = useRouter();
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [modifiedFields, setModifiedFields] = useState<Set<string>>(new Set());
    const inheritedSettings = plugin.resolvedSettings || plugin.settings;
    const workSettings = useMemo(
        () => plugin.workSettings || {},
        [plugin.workSettings],
    );

    const onSave = useCallback(
        async (data: {
            settings?: Record<string, unknown>;
            secretSettings?: Record<string, unknown>;
        }) => {
            const result = await updateWorkPluginSettings(workId, plugin.pluginId, data);
            if (!result.success) {
                throw new Error(result.error);
            }

            const validation = (result.data as Record<string, unknown>)?.validation as
                | { success: boolean; message: string }
                | null
                | undefined;

            if (validation && !validation.success) {
                return { validationError: validation.message };
            }
            if (validation?.success) {
                return { validationSuccess: validation.message };
            }
        },
        [workId, plugin.pluginId],
    );

    const {
        hasChanges,
        isSaving,
        saveSuccess,
        saveMessage,
        validationError,
        visibleProperties,
        handleFieldChange,
        handleSave,
        getFieldValue,
    } = usePluginSettings({
        schema: plugin.settingsSchema,
        initialSettings: workSettings,
        scopes: ['global', 'work'],
        onSave,
        fallbackSettings: inheritedSettings,
        scope: 'work',
    });

    useEffect(() => {
        setModifiedFields(new Set());
    }, [plugin.pluginId, plugin.workSettings]);

    const getWorkFieldValue = useCallback(
        (key: string, propSchema: Parameters<typeof getFieldValue>[1]) => {
            if (modifiedFields.has(key) || key in workSettings) {
                return getFieldValue(key, propSchema);
            }

            const inheritedValue = inheritedSettings?.[key];
            if (inheritedValue !== undefined && inheritedValue !== null && inheritedValue !== '') {
                return inheritedValue;
            }

            return getFieldValue(key, propSchema);
        },
        [workSettings, getFieldValue, inheritedSettings, modifiedFields],
    );

    const handleWorkFieldChange = useCallback(
        (key: string, value: unknown, isSecret: boolean) => {
            setModifiedFields((prev) => new Set(prev).add(key));
            handleFieldChange(key, value, isSecret);
        },
        [handleFieldChange],
    );

    const handleSaveAndClose = async () => {
        await handleSave();
        // Close only if save was successful (no validation error will be set)
        // We rely on saveSuccess being set after a successful save
    };

    const handleReset = async () => {
        const settingsToReset: Record<string, null> = {};
        const secretSettingsToReset: Record<string, null> = {};

        if (plugin.workSettings) {
            for (const key of Object.keys(plugin.workSettings)) {
                // Check if this field is secret based on schema
                const propSchema = plugin.settingsSchema?.properties?.[key];
                if (propSchema && 'secret' in propSchema && propSchema.secret) {
                    secretSettingsToReset[key] = null;
                } else {
                    settingsToReset[key] = null;
                }
            }
        }

        if (
            Object.keys(settingsToReset).length === 0 &&
            Object.keys(secretSettingsToReset).length === 0
        ) {
            setShowResetConfirm(false);
            return;
        }

        setIsResetting(true);
        try {
            const result = await updateWorkPluginSettings(workId, plugin.pluginId, {
                settings: Object.keys(settingsToReset).length > 0 ? settingsToReset : undefined,
                secretSettings:
                    Object.keys(secretSettingsToReset).length > 0
                        ? secretSettingsToReset
                        : undefined,
            });
            if (result.success) {
                router.refresh();
                setShowResetConfirm(false);
                onOpenChange(false);
            } else {
                console.error('Failed to reset settings:', result.error);
            }
        } catch (error) {
            console.error('Failed to reset settings:', error);
        } finally {
            setIsResetting(false);
        }
    };

    const hasWorkOverrides = Object.keys(workSettings).length > 0;

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
                    getFieldValue={getWorkFieldValue}
                    handleFieldChange={handleWorkFieldChange}
                    settingsSchema={plugin.settingsSchema}
                    pluginId={plugin.pluginId}
                    validationError={validationError}
                    renderFieldExtra={(key, propSchema) => {
                        const inheritedValue = inheritedSettings?.[key];
                        const hasWorkValue =
                            modifiedFields.has(key) || key in workSettings;
                        const fieldValue = getWorkFieldValue(key, propSchema);

                        if (
                            !hasWorkValue ||
                            inheritedValue === undefined ||
                            inheritedValue === null ||
                            inheritedValue === '' ||
                            fieldValue === inheritedValue
                        ) {
                            return null;
                        }

                        return (
                            <InheritedValueHint
                                value={inheritedValue}
                                isSecret={propSchema.secret || false}
                            />
                        );
                    }}
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
                        {hasWorkOverrides && !showResetConfirm && (
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
                                {saveMessage || t('saved')}
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
                            className="bg-primary-600"
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
