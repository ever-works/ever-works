'use client';

import { memo, useState, type ChangeEvent } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// react-markdown is ~50KB gzipped with remark-gfm; only load it when a user
// actually opens the preview pane. The chunk is shared with ChatMarkdown.
const MarkdownPreview = dynamic(
    () => import('./MarkdownPreview').then((m) => m.MarkdownPreview),
    { ssr: false },
);

interface MarkdownBodyFieldProps {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    rows?: number;
    label?: string;
    placeholder?: string;
    help?: string;
}

export const MarkdownBodyField = memo(function MarkdownBodyField({
    value,
    onChange,
    disabled,
    rows = 10,
    label,
    placeholder,
    help,
}: MarkdownBodyFieldProps) {
    const t = useTranslations('dashboard.workDetail.items.addModal');
    const [previewOpen, setPreviewOpen] = useState(false);

    // Close the preview when the textarea is cleared. The toggle button is
    // also disabled in that case (value.length === 0), so leaving previewOpen
    // = true would render a disabled "Hide preview" button with no preview
    // pane visible — label contradicts UI state. Doing this during render
    // (vs. useEffect) is the React-recommended pattern for derived state.
    if (previewOpen && value.length === 0) {
        setPreviewOpen(false);
    }

    const fieldLabel = label ?? t('markdown');
    const fieldPlaceholder = placeholder ?? t('markdownPlaceholder');
    const fieldHelp = help ?? t('markdownHelp');

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text dark:text-text-dark">
                    {fieldLabel}
                </label>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPreviewOpen((v) => !v)}
                    disabled={disabled || value.length === 0}
                >
                    {previewOpen ? (
                        <>
                            <EyeOff className="w-4 h-4 mr-1" />
                            {t('hidePreview')}
                        </>
                    ) : (
                        <>
                            <Eye className="w-4 h-4 mr-1" />
                            {t('showPreview')}
                        </>
                    )}
                </Button>
            </div>
            <Textarea
                value={value}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
                placeholder={fieldPlaceholder}
                rows={rows}
                variant="form"
                disabled={disabled}
            />
            {fieldHelp ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{fieldHelp}</p>
            ) : null}
            {previewOpen && value.length > 0 ? (
                <div
                    className={cn(
                        'rounded-lg border border-border dark:border-border-dark',
                        'bg-surface-secondary/40 dark:bg-surface-secondary-dark/40',
                        'px-4 py-3 max-h-72 overflow-auto',
                    )}
                >
                    <MarkdownPreview content={value} />
                </div>
            ) : null}
        </div>
    );
});
