'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
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
    helperLinkHref?: string;
    className?: string;
}

export function resolveWebsiteTemplateSelection(
    templates: WebsiteTemplateOption[],
    value?: string | null,
) {
    const defaultTemplate = templates.find((template) => template.isDefault) || templates[0];
    const explicitTemplate = templates.find((template) => template.id === value) || null;
    const effectiveTemplate = explicitTemplate || defaultTemplate || null;
    const isInheritedSelection = !value;

    return {
        defaultTemplate,
        explicitTemplate,
        effectiveTemplate,
        isInheritedSelection,
    };
}

export function WebsiteTemplateSelector({
    templates,
    value,
    onChange,
    disabled = false,
    label = 'Website Template',
    helperText,
    helperLinkHref,
    className,
}: WebsiteTemplateSelectorProps) {
    const t = useTranslations('dashboard.templateSelector');
    const { defaultTemplate, effectiveTemplate, isInheritedSelection } =
        resolveWebsiteTemplateSelection(templates, value);

    if (!effectiveTemplate) {
        return null;
    }

    const originLabel =
        effectiveTemplate.originType === 'standard'
            ? t('origin.standard')
            : effectiveTemplate.originType === 'forked'
              ? t('origin.forked')
              : t('origin.customUrl');

    return (
        <div className={cn('space-y-2', className)}>
            <div className="space-y-1">
                <label className="text-sm font-medium text-text dark:text-text-dark">{label}</label>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {effectiveTemplate.description}
                </p>
            </div>

            <Select value={value || ''} onValueChange={onChange} disabled={disabled}>
                <option value="">
                    {defaultTemplate
                        ? t('defaultOptionWithName', { name: defaultTemplate.name })
                        : t('defaultOption')}
                </option>
                {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                        {template.isDefault
                            ? t('optionDefaultLabel', { name: template.name })
                            : t('optionLabel', { name: template.name })}
                    </option>
                ))}
            </Select>

            <div className="rounded-lg border border-border bg-surface px-3 py-3 dark:border-border-dark dark:bg-white/4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text dark:text-text-dark">
                        {isInheritedSelection ? t('state.inheritedTitle') : t('state.pinnedTitle')}
                    </span>
                    {isInheritedSelection ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            {t('state.defaultBadge')}
                        </span>
                    ) : null}
                    <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] font-medium text-text-secondary dark:bg-white/8 dark:text-text-secondary-dark">
                        {originLabel}
                    </span>
                </div>
                <p className="mt-1 text-sm font-medium text-text dark:text-text-dark">
                    {effectiveTemplate.name}
                </p>
                <p className="mt-1 text-xs leading-5 text-text-secondary dark:text-text-secondary-dark">
                    {isInheritedSelection
                        ? t('state.inheritedDescription')
                        : t('state.pinnedDescription')}
                </p>
            </div>

            {helperText ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    <span>{helperText}</span>
                    {helperLinkHref ? (
                        <>
                            {' '}
                            <Link
                                href={helperLinkHref}
                                className="font-medium text-primary hover:underline dark:text-primary-dark"
                            >
                                {t('changeAnywayLink')}
                            </Link>
                        </>
                    ) : null}
                </p>
            ) : null}
        </div>
    );
}
