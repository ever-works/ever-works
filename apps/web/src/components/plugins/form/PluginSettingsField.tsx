// PluginSettingsField.tsx
'use client';

import { useTranslations } from 'next-intl';
import { PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Eye, EyeOff, Pencil, X, KeyRound } from 'lucide-react';
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
    const [isEditing, setIsEditing] = useState(false);
    const [previousMaskedValue, setPreviousMaskedValue] = useState<string | null>(null);

    const label = schema.title || name;
    const description = schema.description;
    const isSecret = schema.secret;
    const primaryType = getPrimaryType(schema.type);

    // Check if the current value is a masked placeholder from the API
    const isMaskedValue = isSecret && typeof value === 'string' && value.includes('••••');
    const isEffectivelyEditing = isEditing && !isMaskedValue;

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
            // Empty string is not a valid SelectItem value (Radix UI constraint), so map it to '__none__'
            const currentValue = String(value ?? schema.default ?? '') || '__none__';
            return (
                <Select
                    value={currentValue}
                    onValueChange={(v) => onChange(v === '__none__' ? '' : v)}
                >
                    <option value="__none__">{t('selectPlaceholder')}</option>
                    {schema.enum.map((opt) => (
                        <option key={String(opt)} value={String(opt)}>
                            {String(opt)}
                        </option>
                    ))}
                </Select>
            );
        }

        // Number/Integer input — use shared Input component
        if (isType(schema.type, 'number') || isType(schema.type, 'integer')) {
            return (
                <Input
                    type="number"
                    step={isType(schema.type, 'integer') ? '1' : 'any'}
                    value={
                        value === null
                            ? ''
                            : value !== undefined
                              ? String(Number(value))
                              : schema.default !== undefined
                                ? String(Number(schema.default))
                                : ''
                    }
                    onChange={(e) =>
                        onChange(
                            e.currentTarget.value === ''
                                ? null
                                : isType(schema.type, 'integer')
                                  ? parseInt(e.currentTarget.value, 10)
                                  : parseFloat(e.currentTarget.value),
                        )
                    }
                    min={schema.minimum?.toString()}
                    max={schema.maximum?.toString()}
                    required={required}
                    variant="form"
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

        // Secret field with existing masked value: show a placeholder with "Modify" button
        // instead of putting masked characters in the input (which caused ByteString errors
        // when masked values were accidentally saved back).
        if (isMaskedValue && !isEffectivelyEditing) {
            return (
                <div className="flex items-center gap-2">
                    <div
                        className={cn(
                            'flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                            'bg-surface-tertiary/50 dark:bg-surface-tertiary-dark/50',
                            'text-text-muted dark:text-text-muted-dark text-sm',
                        )}
                    >
                        <KeyRound className="w-4 h-4 shrink-0" />
                        <span className="select-none">{String(value)}</span>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            setPreviousMaskedValue(String(value));
                            setIsEditing(true);
                            onChange('');
                        }}
                        className={cn(
                            'flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                            'bg-surface-secondary dark:bg-surface-secondary-dark',
                            'text-text-muted dark:text-text-muted-dark',
                            'hover:text-text dark:hover:text-text-dark hover:border-primary/50',
                            'transition-colors text-sm font-medium',
                        )}
                    >
                        <Pencil className="w-3.5 h-3.5" />
                        {t('modify')}
                    </button>
                </div>
            );
        }

        // Editing mode for secret field (after clicking Modify) or new secret field
        // Also used for non-secret string fields
        return (
            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <Input
                        type={getInputType()}
                        value={String(value ?? schema.default ?? '')}
                        onChange={(e) => onChange(e.currentTarget.value)}
                        maxLength={schema.maxLength}
                        required={required}
                        autoFocus={isEffectivelyEditing}
                        placeholder={isEffectivelyEditing ? t('enterNewValue') : undefined}
                        variant="form"
                        className={cn(isSecret && 'pr-10')}
                    />
                    {isSecret && (
                        <button
                            type="button"
                            onClick={() => setShowSecret(!showSecret)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                        >
                            {showSecret ? (
                                <EyeOff className="w-4 h-4" />
                            ) : (
                                <Eye className="w-4 h-4" />
                            )}
                        </button>
                    )}
                </div>
                {isEffectivelyEditing && previousMaskedValue && (
                    <button
                        type="button"
                        onClick={() => {
                            onChange(previousMaskedValue);
                            setPreviousMaskedValue(null);
                            setIsEditing(false);
                        }}
                        className={cn(
                            'flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                            'bg-surface-secondary dark:bg-surface-secondary-dark',
                            'text-text-muted dark:text-text-muted-dark',
                            'hover:text-text dark:hover:text-text-dark hover:border-danger/50',
                            'transition-colors text-sm font-medium',
                        )}
                    >
                        <X className="w-3.5 h-3.5" />
                        {t('cancel')}
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
                <p className="text-xs text-warning dark:text-warning items-center gap-1 hidden">
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
