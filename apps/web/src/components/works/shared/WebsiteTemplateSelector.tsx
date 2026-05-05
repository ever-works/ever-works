'use client';

import { Select } from '@/components/ui/select';
import type { WebsiteTemplateOption } from '@/lib/api/work';
import { cn } from '@/lib/utils/cn';

interface WebsiteTemplateSelectorProps {
    templates: WebsiteTemplateOption[];
    value?: string | null;
    onChange: (value: string) => void;
    disabled?: boolean;
    label?: string;
    helperText?: string;
    className?: string;
    defaultOptionLabel?: string;
}

export function WebsiteTemplateSelector({
    templates,
    value,
    onChange,
    disabled = false,
    label = 'Website Template',
    helperText,
    className,
    defaultOptionLabel,
}: WebsiteTemplateSelectorProps) {
    const defaultTemplate = templates.find((template) => template.isDefault) || templates[0];
    const selectedTemplate = templates.find((template) => template.id === value) || defaultTemplate;

    if (!selectedTemplate) {
        return null;
    }

    return (
        <div className={cn('space-y-2', className)}>
            <div className="space-y-1">
                <label className="text-sm font-medium text-text dark:text-text-dark">{label}</label>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {selectedTemplate.description}
                </p>
            </div>

            <Select value={value || ''} onValueChange={onChange} disabled={disabled}>
                <option value="">
                    {defaultOptionLabel ||
                        (defaultTemplate ? `Use default (${defaultTemplate.name})` : 'Use default')}
                </option>
                {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                        {template.name}
                        {template.isDefault ? ' (Default)' : ''}
                    </option>
                ))}
            </Select>

            {helperText ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{helperText}</p>
            ) : null}
        </div>
    );
}
