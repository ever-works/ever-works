'use client';

import { ReactNode } from 'react';
import { PluginSettingsSchemaProperty, PluginSettingsSchema } from '@/lib/api/plugins';
import { PluginSettingsField } from './PluginSettingsField';
import { AlertCircle } from 'lucide-react';

interface PluginSettingsFormFieldsProps {
    visibleProperties: Record<string, PluginSettingsSchemaProperty>;
    getFieldValue: (key: string, propSchema: PluginSettingsSchemaProperty) => unknown;
    handleFieldChange: (key: string, value: unknown, isSecret: boolean) => void;
    settingsSchema?: PluginSettingsSchema;
    pluginId: string;
    validationError: string | null;
    /** Optional render function for extra content below each field (e.g. inherited value hints) */
    renderFieldExtra?: (key: string, propSchema: PluginSettingsSchemaProperty) => ReactNode;
}

/**
 * Shared form body for rendering plugin settings fields + validation errors.
 * Used by both the user-level PluginSettings page and DirectoryPluginSettingsModal.
 */
export function PluginSettingsFormFields({
    visibleProperties,
    getFieldValue,
    handleFieldChange,
    settingsSchema,
    pluginId,
    validationError,
    renderFieldExtra,
}: PluginSettingsFormFieldsProps) {
    return (
        <>
            <div className="space-y-4">
                {Object.entries(visibleProperties).map(([key, propSchema]) => (
                    <div key={key}>
                        <PluginSettingsField
                            name={key}
                            schema={propSchema}
                            value={getFieldValue(key, propSchema)}
                            required={settingsSchema?.required?.includes(key)}
                            onChange={(value) =>
                                handleFieldChange(key, value, propSchema.secret || false)
                            }
                            pluginId={pluginId}
                        />
                        {renderFieldExtra?.(key, propSchema)}
                    </div>
                ))}
            </div>

            {validationError && (
                <div className="mt-4 p-3 rounded-lg bg-danger/10 border border-danger/20 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                    <p className="text-sm text-danger">{validationError}</p>
                </div>
            )}
        </>
    );
}
