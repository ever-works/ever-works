// PluginSettingsArrayField.tsx
'use client';

import { useTranslations } from 'next-intl';
import { PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { Plus, X } from 'lucide-react';
import { PluginSettingsField } from './PluginSettingsField';

interface PluginSettingsArrayFieldProps {
    name: string;
    schema: PluginSettingsSchemaProperty;
    value: unknown[];
    onChange: (value: unknown[]) => void;
    pluginId?: string;
}

export function PluginSettingsArrayField({
    name,
    schema,
    value,
    onChange,
    pluginId,
}: PluginSettingsArrayFieldProps) {
    const t = useTranslations('dashboard.plugins.settingsField');
    const items = value || [];
    const itemSchema = schema.items || { type: 'string' };

    const addItem = () => {
        const newItem =
            itemSchema.default !== undefined
                ? itemSchema.default
                : getDefaultValueForType(itemSchema);

        onChange([...items, newItem]);
    };

    const removeItem = (index: number) => {
        onChange(items.filter((_, i) => i !== index));
    };

    const updateItem = (index: number, newValue: unknown) => {
        const newItems = [...items];
        newItems[index] = newValue;
        onChange(newItems);
    };

    const getDefaultValueForType = (schema: PluginSettingsSchemaProperty): unknown => {
        const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
        switch (type) {
            case 'boolean':
                return false;
            case 'number':
            case 'integer':
                return 0;
            case 'object':
                return {};
            case 'array':
                return [];
            default:
                return '';
        }
    };

    return (
        <div className="space-y-2">
            {items.map((item, index) => (
                <div key={index} className="flex gap-2 items-start">
                    <div className="flex-1">
                        <PluginSettingsField
                            name={`${name}[${index}]`}
                            schema={itemSchema}
                            value={item}
                            onChange={(val) => updateItem(index, val)}
                            pluginId={pluginId}
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => removeItem(index)}
                        className="p-2 mt-1 text-danger hover:bg-danger/10 rounded-lg transition-colors"
                        aria-label={t('removeItem')}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            ))}

            <button
                type="button"
                onClick={addItem}
                disabled={schema.maxItems !== undefined && items.length >= schema.maxItems}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
                <Plus className="w-4 h-4" />
                {t('addItem')}
            </button>
        </div>
    );
}
