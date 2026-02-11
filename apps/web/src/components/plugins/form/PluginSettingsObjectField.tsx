'use client';

import { PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { PluginSettingsField } from './PluginSettingsField';

interface PluginSettingsObjectFieldProps {
    name: string;
    schema: PluginSettingsSchemaProperty;
    value: Record<string, unknown>;
    onChange: (value: Record<string, unknown>) => void;
    pluginId?: string;
}

export function PluginSettingsObjectField({
    name,
    schema,
    value,
    onChange,
    pluginId,
}: PluginSettingsObjectFieldProps) {
    const properties = schema.properties || {};
    const requiredFields = schema.required || [];
    const currentValue = value || {};

    const handlePropertyChange = (propName: string, propValue: unknown) => {
        onChange({
            ...currentValue,
            [propName]: propValue,
        });
    };

    return (
        <div className="space-y-4 p-3 rounded-lg border border-border dark:border-border-dark">
            {Object.entries(properties).map(([propName, propSchema]) => (
                <PluginSettingsField
                    key={`${name}.${propName}`}
                    name={propName}
                    schema={propSchema}
                    value={currentValue[propName]}
                    required={requiredFields.includes(propName)}
                    onChange={(val) => handlePropertyChange(propName, val)}
                    pluginId={pluginId}
                />
            ))}
        </div>
    );
}
