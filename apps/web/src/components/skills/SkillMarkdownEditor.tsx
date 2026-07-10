'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Eye, Pencil } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';

// react-markdown + remark-gfm is ~50KB gzipped; only load it when a user
// actually opens the Preview tab. The chunk is shared with the items
// MarkdownBodyField and ChatMarkdown.
const MarkdownPreview = dynamic(
    () => import('@/components/works/detail/items/MarkdownPreview').then((m) => m.MarkdownPreview),
    { ssr: false },
);

/**
 * Shared Write/Preview markdown editor for Skill bodies. Used by the
 * /skills/[id] Instructions section and the /skills/new details step
 * so both surfaces get the same tabs, click-to-edit preview, and
 * markdown-hint + word/char-count footer. Strings live under
 * `dashboard.skillsPage.detail.body`.
 */
export function SkillMarkdownEditor({
    value,
    onChange,
    rows = 20,
    placeholder,
    label,
    headerExtra,
    idPrefix = 'skill-md',
    textareaId,
    textareaClassName = 'p-3 font-mono text-xs resize-y leading-relaxed',
}: {
    value: string;
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
    rows?: number;
    placeholder?: string;
    /** Left side of the header row (e.g. a section heading or field label). */
    label?: ReactNode;
    /** Right side of the header row, before the tabs (e.g. save status). */
    headerExtra?: ReactNode;
    /** Unique prefix for the tab/panel element ids when multiple editors coexist. */
    idPrefix?: string;
    textareaId?: string;
    textareaClassName?: string;
}) {
    const t = useTranslations('dashboard.skillsPage.detail.body');
    const [mode, setMode] = useState<'write' | 'preview'>('write');
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // Click-to-edit: clicking the rendered preview flips back to Write
    // and drops the caret into the textarea once it has re-rendered.
    const focusPendingRef = useRef(false);

    useEffect(() => {
        if (mode === 'write' && focusPendingRef.current) {
            focusPendingRef.current = false;
            textareaRef.current?.focus();
        }
    }, [mode]);

    const wordCount = useMemo(() => {
        const trimmed = value.trim();
        return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
    }, [value]);

    const tabClass = (selected: boolean) =>
        `inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors ${
            selected
                ? 'border-border-secondary dark:border-border-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark font-medium text-text dark:text-text-dark'
                : 'border-border/60 dark:border-border-dark/60 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-border dark:hover:border-border-dark'
        }`;

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                {label ?? <span />}
                <div className="flex items-center gap-3">
                    {headerExtra}
                    <div role="tablist" aria-label={t('write')} className="flex gap-1.5">
                        <button
                            id={`${idPrefix}-tab-write`}
                            type="button"
                            role="tab"
                            aria-selected={mode === 'write'}
                            aria-controls={`${idPrefix}-panel-write`}
                            onClick={() => setMode('write')}
                            className={tabClass(mode === 'write')}
                        >
                            <Pencil className="w-3 h-3" />
                            {t('write')}
                        </button>
                        <button
                            id={`${idPrefix}-tab-preview`}
                            type="button"
                            role="tab"
                            aria-selected={mode === 'preview'}
                            aria-controls={`${idPrefix}-panel-preview`}
                            onClick={() => setMode('preview')}
                            className={tabClass(mode === 'preview')}
                        >
                            <Eye className="w-3 h-3" />
                            {t('preview')}
                        </button>
                    </div>
                </div>
            </div>
            {mode === 'write' ? (
                <div
                    id={`${idPrefix}-panel-write`}
                    role="tabpanel"
                    aria-labelledby={`${idPrefix}-tab-write`}
                >
                    <Textarea
                        ref={textareaRef}
                        id={textareaId}
                        variant="form"
                        value={value}
                        onChange={onChange}
                        rows={rows}
                        spellCheck={false}
                        placeholder={placeholder ?? t('placeholder')}
                        className={textareaClassName}
                    />
                </div>
            ) : (
                <div
                    id={`${idPrefix}-panel-preview`}
                    role="tabpanel"
                    aria-labelledby={`${idPrefix}-tab-preview`}
                    title={t('clickToEdit')}
                    onClick={(e) => {
                        // Let links in the rendered markdown behave as links.
                        if ((e.target as HTMLElement).closest('a')) return;
                        focusPendingRef.current = true;
                        setMode('write');
                    }}
                    className="rounded-lg border border-border/40 dark:border-border-dark/40 bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 px-4 py-3 min-h-40 max-h-128 overflow-auto cursor-text hover:border-border dark:hover:border-border-dark transition-colors"
                >
                    {value.trim().length > 0 ? (
                        <MarkdownPreview content={value} />
                    ) : (
                        <p className="text-xs text-text-muted">{t('emptyPreview')}</p>
                    )}
                </div>
            )}
            <div className="flex items-center justify-between gap-3 text-[11px] text-text-muted pt-1 border-t border-border/40 dark:border-border-dark/40">
                <span>{t('markdownHint')}</span>
                <span>
                    {t('words', { count: wordCount })} · {t('characters', { count: value.length })}
                </span>
            </div>
        </div>
    );
}
