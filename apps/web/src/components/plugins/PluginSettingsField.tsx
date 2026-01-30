'use client';

import { PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

interface PluginSettingsFieldProps {
    name: string;
    schema: PluginSettingsSchemaProperty;
    value: unknown;
    required?: boolean;
    onChange: (value: unknown) => void;
}

export function PluginSettingsField({
    name,
    schema,
    value,
    required,
    onChange,
}: PluginSettingsFieldProps) {
    const [showSecret, setShowSecret] = useState(false);

    const label = schema.title || name;
    const description = schema.description;
    const isSecret = schema.secret || schema.masked;
    const isMasked = schema.masked && value === '********';

    // Determine input type
    const getInputType = () => {
        if (isSecret && !showSecret) return 'password';
        if (schema.type === 'number') return 'number';
        return 'text';
    };

    // Render based on schema type
    const renderInput = () => {
        // Boolean - checkbox/toggle
        if (schema.type === 'boolean') {
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

        // Enum - select
        if (schema.enum && schema.enum.length > 0) {
            return (
                <select
                    value={String(value ?? schema.default ?? '')}
                    onChange={(e) => onChange(e.target.value)}
                    className={cn(
                        'w-full px-3 py-2 rounded-lg border border-border dark:border-border-dark',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text dark:text-text-dark',
                        'focus:outline-none focus:ring-2 focus:ring-primary/50',
                    )}
                >
                    <option value="">Select...</option>
                    {schema.enum.map((opt) => (
                        <option key={String(opt)} value={String(opt)}>
                            {String(opt)}
                        </option>
                    ))}
                </select>
            );
        }

        // Number input
        if (schema.type === 'number') {
            return (
                <input
                    type="number"
                    value={
                        value !== undefined
                            ? Number(value)
                            : schema.default !== undefined
                              ? Number(schema.default)
                              : ''
                    }
                    onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
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

        // String input (default) - with secret support
        return (
            <div className="relative">
                <input
                    type={getInputType()}
                    value={isMasked ? '' : String(value ?? schema.default ?? '')}
                    onChange={(e) => onChange(e.target.value || undefined)}
                    placeholder={
                        isMasked
                            ? '••••••••'
                            : schema.default !== undefined
                              ? String(schema.default)
                              : undefined
                    }
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
                    This field is encrypted
                </p>
            )}
        </div>
    );
}
