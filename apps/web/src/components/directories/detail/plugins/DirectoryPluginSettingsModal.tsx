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
import { RotateCcw, Save, Check, Activity } from 'lucide-react';

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
            const result = await updateDirectoryPluginSettings(directoryId, plugin.pluginId, data);
            if (!result.success) {
                throw new Error(result.error);
            }
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
        scope: 'directory',
    });

    const handleSaveAndClose = async () => {
        await handleSave();
        // Close only if save was successful (no validation error will be set)
        // We rely on saveSuccess being set after a successful save
    };

    const handleReset = async () => {
        const settingsToReset: Record<string, null> = {};
        const secretSettingsToReset: Record<string, null> = {};

        if (plugin.directorySettings) {
            for (const key of Object.keys(plugin.directorySettings)) {
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
            const result = await updateDirectoryPluginSettings(directoryId, plugin.pluginId, {
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

    const hasMetadata = plugin.metadata && Object.keys(plugin.metadata).length > 0;
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

                {/* Plugin metadata status */}
                {hasMetadata && (
                    <PluginMetadataStatus metadata={plugin.metadata!} />
                )}

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

function formatMetadataValue(key: string, value: unknown): string {
    if (value === null || value === undefined) return '-';
    if (Array.isArray(value)) return String(value.length);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return new Date(value).toLocaleString();
    }
    return String(value);
}

function formatMetadataLabel(key: string): string {
    return key
        .replace(/([A-Z])/g, ' $1')
        .replace(/[_-]/g, ' ')
        .replace(/^\w/, (c) => c.toUpperCase())
        .trim();
}

function PluginMetadataStatus({ metadata }: { metadata: Record<string, unknown> }) {
    const displayEntries = Object.entries(metadata).filter(
        ([key]) => key !== 'processedPrNumbers',
    );

    if (displayEntries.length === 0) return null;

    return (
        <div className="rounded-lg border border-border dark:border-border-dark p-3 mt-2">
            <div className="flex items-center gap-1.5 mb-2">
                <Activity className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark" />
                <span className="text-xs font-medium text-text-muted dark:text-text-muted-dark uppercase tracking-wide">
                    Status
                </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {displayEntries.map(([key, value]) => (
                    <div key={key} className="contents">
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {formatMetadataLabel(key)}
                        </span>
                        <span className="text-xs text-text dark:text-text-dark font-medium text-right">
                            {formatMetadataValue(key, value)}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
