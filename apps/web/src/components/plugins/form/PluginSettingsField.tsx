// PluginSettingsField.tsx
'use client';

import { useTranslations } from 'next-intl';
import { PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { PluginModelSelect } from './PluginModelSelect';
import { PluginSettingsObjectField } from './PluginSettingsObjectField';
import { PluginSettingsArrayField } from './PluginSettingsArrayField';
import { isType, getPrimaryType } from './utils';

interface PluginSettingsFieldProps {
    name: string;
    schema: PluginSettingsSchemaProperty;
    value: unknown;
    required?: boolean;
    onChange: (value: unknown) => void;
    pluginId?: string;
}

export function PluginSettingsField({
    name,
    schema,
    value,
    required,
    onChange,
    pluginId,
}: PluginSettingsFieldProps) {
    const t = useTranslations('dashboard.plugins.settingsField');
    const [showSecret, setShowSecret] = useState(false);

    const label = schema.title || name;
    const description = schema.description;
    const isSecret = schema.secret;
    const primaryType = getPrimaryType(schema.type);

    // Determine input type for string/number inputs
    const getInputType = () => {
        if (isSecret && !showSecret) return 'password';
        if (isType(schema.type, 'number') || isType(schema.type, 'integer')) return 'number';
        return 'text';
    };

    // Handle null type with default
    if (primaryType === 'null') {
        return (
            <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text dark:text-text-dark">
                    {label}
                    {required && <span className="text-danger ml-1">*</span>}
                </label>
                <div className="px-3 py-2 rounded-lg border border-border dark:border-border-dark bg-surface-tertiary/50 dark:bg-surface-tertiary-dark/50 text-text-muted dark:text-text-muted-dark text-sm">
                    {t('nullValue')}
                </div>
                {description && (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {description}
                    </p>
                )}
            </div>
        );
    }

    // Render based on schema type
    const renderInput = () => {
        // Object type
        if (isType(schema.type, 'object')) {
            return (
                <PluginSettingsObjectField
                    name={name}
                    schema={schema}
                    value={(value as Record<string, unknown>) || {}}
                    onChange={onChange}
                    pluginId={pluginId}
                />
            );
        }

        // Array type
        if (isType(schema.type, 'array')) {
            return (
                <PluginSettingsArrayField
                    name={name}
                    schema={schema}
                    value={(value as unknown[]) || []}
                    onChange={onChange}
                    pluginId={pluginId}
                />
            );
        }

        // Boolean - checkbox/toggle
        if (isType(schema.type, 'boolean')) {
            return (
                <label className="relative inline-flex items-center cursor-pointer">
                    <input
                        type="checkbox"
                        checked={Boolean(value ?? schema.default)}
                        onChange={(e) => onChange(e.target.checked)}
                        className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-surface-tertiary dark:bg-surface-tertiary-dark peer-focus:ring-2 peer-focus:ring-primary/50 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                </label>
            );
        }

        // Enum - select (works for any type)
        if (schema.enum && schema.enum.length > 0) {
            return (
                <select
                    value={String(value ?? schema.default ?? '')}
                    onChange={(e) => onChange(e.target.value || null)}
                    required={required}
                    className={cn(
                        'w-full px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text dark:text-text-dark',
                        'focus:outline-none focus:ring-2 focus:ring-primary/50',
                    )}
                >
                    <option value="">{t('selectPlaceholder')}</option>
                    {schema.enum.map((opt) => (
                        <option key={String(opt)} value={String(opt)}>
                            {String(opt)}
                        </option>
                    ))}
                </select>
            );
        }

        // Number/Integer input
        if (isType(schema.type, 'number') || isType(schema.type, 'integer')) {
            return (
                <input
                    type="number"
                    step={isType(schema.type, 'integer') ? 1 : 'any'}
                    value={
                        value === null
                            ? ''
                            : value !== undefined
                              ? Number(value)
                              : schema.default !== undefined
                                ? Number(schema.default)
                                : ''
                    }
                    onChange={(e) =>
                        onChange(
                            e.target.value === ''
                                ? null
                                : isType(schema.type, 'integer')
                                  ? parseInt(e.target.value, 10)
                                  : parseFloat(e.target.value),
                        )
                    }
                    min={schema.minimum}
                    max={schema.maximum}
                    required={required}
                    className={cn(
                        'w-full px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text dark:text-text-dark',
                        'focus:outline-none focus:ring-2 focus:ring-primary/50',
                    )}
                    placeholder={schema.default !== undefined ? String(schema.default) : undefined}
                />
            );
        }

        // Model select widget
        if (schema.widget === 'model-select' && pluginId) {
            return (
                <PluginModelSelect
                    pluginId={pluginId}
                    value={String(value ?? schema.default ?? '')}
                    onChange={(val) => onChange(val || null)}
                />
            );
        }

        // String input (default) - with secret support
        return (
            <div className="relative">
                <input
                    type={getInputType()}
                    value={String(value ?? schema.default ?? '')}
                    onChange={(e) => onChange(e.target.value)}
                    maxLength={schema.maxLength}
                    required={required}
                    className={cn(
                        'w-full px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text dark:text-text-dark',
                        'focus:outline-none focus:ring-2 focus:ring-primary/50',
                        isSecret && 'pr-10',
                    )}
                />
                {isSecret && (
                    <button
                        type="button"
                        onClick={() => setShowSecret(!showSecret)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                    >
                        {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                )}
            </div>
        );
    };

    return (
        <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text dark:text-text-dark">
                {label}
                {required && <span className="text-danger ml-1">*</span>}
            </label>

            {renderInput()}

            {description && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{description}</p>
            )}

            {isSecret && (
                <p className="text-xs text-warning dark:text-warning flex items-center gap-1">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path
                            fillRule="evenodd"
                            d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                            clipRule="evenodd"
                        />
                    </svg>
                    {t('fieldEncrypted')}
                </p>
            )}
        </div>
    );
}
