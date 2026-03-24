'use client';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import {
    Accordion,
    AccordionItem,
    AccordionTrigger,
    AccordionContent,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import type { FormFieldDefinition, FormFieldGroup } from '@/lib/api/types-only';
import { useState, useCallback, useMemo } from 'react';

interface DynamicPluginFieldsProps {
    fields: FormFieldDefinition[];
    groups?: FormFieldGroup[];
    values: Record<string, unknown>;
    onChange: (values: Record<string, unknown>) => void;
}

/**
 * Renders dynamic form fields defined by the pipeline plugin.
 */
export function DynamicPluginFields({
    fields,
    groups,
    values,
    onChange,
}: DynamicPluginFieldsProps) {
    const t = useTranslations('dashboard.directoryDetail.generator');

    // Deduplicate fields by name (first occurrence wins)
    const uniqueFields = useMemo(() => {
        const seen = new Set<string>();
        return fields.filter((f) => {
            if (seen.has(f.name)) return false;
            seen.add(f.name);
            return true;
        });
    }, [fields]);

    // Compute default expanded groups for the accordion
    const defaultExpandedGroups = useMemo(() => {
        if (!groups) return [];
        return groups.filter((g) => !g.collapsible || !g.collapsed).map((g) => g.name);
    }, [groups]);

    const handleFieldChange = useCallback(
        (fieldName: string, value: unknown) => {
            onChange({ ...values, [fieldName]: value });
        },
        [values, onChange],
    );

    const evaluateCondition = useCallback(
        (condition: { field: string; operator: string; value: unknown }): boolean => {
            const currentValue = values[condition.field];
            switch (condition.operator) {
                case 'eq':
                    return currentValue === condition.value;
                case 'neq':
                case 'ne':
                    return currentValue !== condition.value;
                case 'gt':
                    return (
                        typeof currentValue === 'number' &&
                        currentValue > (condition.value as number)
                    );
                case 'gte':
                    return (
                        typeof currentValue === 'number' &&
                        currentValue >= (condition.value as number)
                    );
                case 'lt':
                    return (
                        typeof currentValue === 'number' &&
                        currentValue < (condition.value as number)
                    );
                case 'lte':
                    return (
                        typeof currentValue === 'number' &&
                        currentValue <= (condition.value as number)
                    );
                case 'contains':
                    return String(currentValue).includes(String(condition.value));
                case 'not_contains':
                    return !String(currentValue).includes(String(condition.value));
                case 'in':
                    return Array.isArray(condition.value) && condition.value.includes(currentValue);
                default:
                    return true;
            }
        },
        [values],
    );

    const shouldShowField = useCallback(
        (field: FormFieldDefinition): boolean => {
            if (!field.showIf) return true;

            // Handle both single condition and array of conditions (all must be true)
            const conditions = Array.isArray(field.showIf) ? field.showIf : [field.showIf];
            return conditions.every(evaluateCondition);
        },
        [evaluateCondition],
    );

    const renderField = useCallback(
        (field: FormFieldDefinition) => {
            if (!shouldShowField(field)) return null;

            const value = values[field.name] ?? field.defaultValue;

            switch (field.type) {
                case 'text':
                case 'url':
                case 'password':
                    return (
                        <Input
                            key={field.name}
                            label={field.label}
                            type={
                                field.type === 'url'
                                    ? 'url'
                                    : field.type === 'password'
                                      ? 'password'
                                      : 'text'
                            }
                            value={(value as string) || ''}
                            onChange={(e) => handleFieldChange(field.name, e.target.value)}
                            placeholder={field.placeholder}
                            helperText={field.description}
                            required={field.validation?.required}
                            variant="form"
                            minLength={field.validation?.min}
                            maxLength={field.validation?.max}
                        />
                    );

                case 'number':
                    return (
                        <Input
                            key={field.name}
                            label={field.label}
                            type="number"
                            value={value !== undefined ? String(value) : ''}
                            onChange={(e) =>
                                handleFieldChange(field.name, parseFloat(e.target.value) || 0)
                            }
                            placeholder={field.placeholder}
                            helperText={field.description}
                            required={field.validation?.required}
                            variant="form"
                            min={field.validation?.min?.toString()}
                            max={field.validation?.max?.toString()}
                        />
                    );

                case 'textarea':
                    return (
                        <div key={field.name}>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-1">
                                {field.label}
                                {field.validation?.required && (
                                    <span className="text-danger ml-1">*</span>
                                )}
                            </label>
                            <textarea
                                value={(value as string) || ''}
                                onChange={(e) => handleFieldChange(field.name, e.target.value)}
                                placeholder={field.placeholder}
                                className={cn(
                                    'w-full px-3 py-2 rounded-lg border text-sm resize-none',
                                    'bg-surface dark:bg-surface-dark',
                                    'border-border dark:border-border-dark',
                                    'text-text dark:text-text-dark',
                                    'focus:outline-none focus:ring-2 focus:ring-primary/50',
                                )}
                                rows={4}
                                minLength={field.validation?.min}
                                maxLength={field.validation?.max}
                            />
                            {field.description && (
                                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                    {field.description}
                                </p>
                            )}
                        </div>
                    );

                case 'boolean':
                    return (
                        <Switch
                            key={field.name}
                            label={field.label}
                            checked={Boolean(value)}
                            onChange={(checked) => handleFieldChange(field.name, checked)}
                            helperText={field.description}
                        />
                    );

                case 'select':
                    return (
                        <div key={field.name}>
                            {field.label && (
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                    {field.label}
                                    {field.validation?.required && (
                                        <span className="text-danger ml-1">*</span>
                                    )}
                                </label>
                            )}
                            <Select
                                value={(value as string) || '__none__'}
                                onValueChange={(val) =>
                                    handleFieldChange(field.name, val === '__none__' ? '' : val)
                                }
                            >
                                {!field.validation?.required && (
                                    <option value="__none__">
                                        {field.placeholder || t('selectOption')}
                                    </option>
                                )}
                                {field.options?.map((option) => (
                                    <option key={String(option.value)} value={String(option.value)}>
                                        {option.label}
                                    </option>
                                ))}
                            </Select>
                            {field.description && (
                                <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                                    {field.description}
                                </p>
                            )}
                        </div>
                    );

                case 'json':
                    return (
                        <JsonField
                            key={field.name}
                            field={field}
                            value={value as Record<string, unknown> | undefined}
                            onChange={(val) => handleFieldChange(field.name, val)}
                        />
                    );

                case 'tags':
                    return (
                        <TagsField
                            key={field.name}
                            field={field}
                            value={(value as string[]) || []}
                            onChange={(tags) => handleFieldChange(field.name, tags)}
                        />
                    );

                default:
                    return null;
            }
        },
        [values, handleFieldChange, shouldShowField, t],
    );

    // If no groups defined, render all fields in order
    if (!groups || groups.length === 0) {
        return <div className="space-y-4">{uniqueFields.map(renderField)}</div>;
    }

    // Deduplicate groups by name (first wins), then sort by order
    const seenGroups = new Set<string>();
    const sortedGroups = [...groups]
        .filter((g) => {
            if (seenGroups.has(g.name)) return false;
            seenGroups.add(g.name);
            return true;
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // Get fields without a group
    const ungroupedFields = uniqueFields.filter((f) => !f.group);

    return (
        <div className="space-y-6">
            {/* Render ungrouped fields first */}
            {ungroupedFields.length > 0 && (
                <div className="space-y-4">{ungroupedFields.map(renderField)}</div>
            )}

            {/* Render grouped fields */}
            <Accordion type="multiple" defaultValue={defaultExpandedGroups} className="space-y-3">
                {sortedGroups.map((group) => {
                    const groupFields = uniqueFields.filter((f) => f.group === group.name);
                    if (groupFields.length === 0) return null;

                    return group.collapsible ? (
                        <AccordionItem
                            key={group.name}
                            value={group.name}
                            className={cn(
                                'rounded-lg border overflow-hidden',
                                'bg-card dark:bg-card-primary-dark/30',
                                'border-card-border dark:border-card-border-dark',
                            )}
                        >
                            <AccordionTrigger className="px-5 py-3.5 hover:no-underline hover:bg-surface/50 dark:hover:bg-surface-dark/50">
                                <div>
                                    <h3 className="text-md font-semibold text-text dark:text-text-dark">
                                        {group.title}
                                    </h3>
                                    {group.description && (
                                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 font-normal">
                                            {group.description}
                                        </p>
                                    )}
                                </div>
                            </AccordionTrigger>
                            <AccordionContent className="px-5 pb-4 pt-2">
                                <div className="space-y-4">{groupFields.map(renderField)}</div>
                            </AccordionContent>
                        </AccordionItem>
                    ) : (
                        <div
                            key={group.name}
                            className={cn(
                                'rounded-lg border overflow-hidden',
                                'bg-card dark:bg-card-primary-dark/30',
                                'border-card-border dark:border-card-border-dark',
                            )}
                        >
                            <div className="px-5 py-3.5 border-b border-card-border dark:border-card-border-dark">
                                <h3 className="text-md font-semibold text-text dark:text-text-dark">
                                    {group.title}
                                </h3>
                                {group.description && (
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                                        {group.description}
                                    </p>
                                )}
                            </div>
                            <div className="px-5 pb-4 pt-2">
                                <div className="space-y-4">{groupFields.map(renderField)}</div>
                            </div>
                        </div>
                    );
                })}
            </Accordion>
        </div>
    );
}

/**
 * JSON editor field for key-value parameters.
 */
interface JsonFieldProps {
    field: FormFieldDefinition;
    value: Record<string, unknown> | undefined;
    onChange: (value: Record<string, unknown>) => void;
}

function JsonField({ field, value, onChange }: JsonFieldProps) {
    const [rawText, setRawText] = useState(() =>
        value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '',
    );
    const [error, setError] = useState<string | null>(null);

    const handleChange = (text: string) => {
        setRawText(text);

        if (!text.trim()) {
            setError(null);
            onChange({});
            return;
        }

        try {
            const parsed = JSON.parse(text);
            if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
                setError('Must be a JSON object');
                return;
            }
            setError(null);
            onChange(parsed as Record<string, unknown>);
        } catch {
            setError('Invalid JSON');
        }
    };

    return (
        <div>
            <label className="block text-sm font-medium text-text dark:text-text-dark mb-1">
                {field.label}
                {field.validation?.required && <span className="text-danger ml-1">*</span>}
            </label>
            <textarea
                value={rawText}
                onChange={(e) => handleChange(e.target.value)}
                placeholder={field.placeholder || '{\n  "key": "value"\n}'}
                className={cn(
                    'w-full px-3 py-2 rounded-lg border text-sm font-mono resize-none',
                    'bg-surface dark:bg-surface-dark',
                    'text-text dark:text-text-dark',
                    'focus:outline-none focus:ring-2 focus:ring-primary/50',
                    error ? 'border-danger' : 'border-border dark:border-border-dark',
                )}
                rows={4}
            />
            {error && <p className="mt-1 text-xs text-danger">{error}</p>}
            {!error && field.description && (
                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                    {field.description}
                </p>
            )}
        </div>
    );
}

/**
 * Tags input field for array of strings (categories, keywords, URLs, etc.)
 */
interface TagsFieldProps {
    field: FormFieldDefinition;
    value: string[];
    onChange: (tags: string[]) => void;
}

function TagsField({ field, value, onChange }: TagsFieldProps) {
    const [inputValue, setInputValue] = useState('');

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addTag();
        }
    };

    const addTag = () => {
        const trimmed = inputValue.trim();
        if (trimmed && !value.includes(trimmed)) {
            onChange([...value, trimmed]);
        }
        setInputValue('');
    };

    const removeTag = (tag: string) => {
        onChange(value.filter((t) => t !== tag));
    };

    return (
        <div>
            <label className="block text-sm font-medium text-text dark:text-text-dark mb-1">
                {field.label}
                {field.validation?.required && <span className="text-danger ml-1">*</span>}
            </label>
            <div
                className={cn(
                    'min-h-[42px] px-3 py-2 rounded-lg border',
                    'bg-card dark:bg-card-primary-dark/30',
                    'border-card-border dark:border-card-border-dark',
                    'focus-within:ring-2 focus-within:ring-primary/50',
                )}
            >
                <div className="flex flex-wrap gap-2">
                    {value.map((tag) => (
                        <span
                            key={tag}
                            className={cn(
                                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm',
                                'bg-primary/10 text-primary dark:bg-primary-dark/10 dark:text-primary-dark',
                            )}
                        >
                            {tag}
                            <button
                                type="button"
                                onClick={() => removeTag(tag)}
                                className="hover:text-danger"
                            >
                                <svg
                                    className="w-3 h-3"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M6 18L18 6M6 6l12 12"
                                    />
                                </svg>
                            </button>
                        </span>
                    ))}
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onBlur={addTag}
                        placeholder={value.length === 0 ? field.placeholder : ''}
                        className="flex-1 min-w-[100px] bg-transparent border-none outline-none text-sm text-text dark:text-text-dark"
                    />
                </div>
            </div>
            {field.description && (
                <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                    {field.description}
                </p>
            )}
        </div>
    );
}
