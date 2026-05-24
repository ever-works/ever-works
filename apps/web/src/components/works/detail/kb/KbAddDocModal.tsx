'use client';

import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { KB_DOCUMENT_CLASSES, type KbDocumentClass } from '@ever-works/contracts';
import type { KbTagDto } from '@ever-works/contracts';

export interface KbAddDocResult {
    targetClass: KbDocumentClass;
    title: string;
    description: string;
    tags: string[];
}

interface KbAddDocModalProps {
    workId: string;
    initialClass?: KbDocumentClass;
    onConfirm: (result: KbAddDocResult) => void;
    onCancel: () => void;
    /**
     * Test seam: skip the network fetch + use the provided tag list.
     * Production code leaves this undefined so the modal fetches lazily.
     */
    initialTags?: KbTagDto[];
    /** When true, the confirm button shows the busy label + disables interaction. */
    busy?: boolean;
    /** Optional inline error surfaced under the form footer. */
    error?: string | null;
}

/**
 * EW-641 KB workbench follow-up — "Create a new document" modal.
 *
 * Mirrors `KbClassifyModal`'s chrome (panel shape, dark-theme overlay
 * fix, ESC-to-close, click-outside-to-cancel) so the two creation
 * surfaces feel like siblings. Differs in two ways:
 *
 *  - It collects a single `title` + (optional) `description` for one
 *    new doc, not per-file titles. The title is required; the confirm
 *    button is disabled until it has content.
 *  - There is no file list — the doc is born empty and the user lands
 *    in the Tiptap editor on the new path.
 *
 * Tag chip + autocomplete behaviour is copy-equivalent to the
 * classify-modal UX so operators don't have to relearn the input.
 *
 * Selectors locked for tests and operator screen-reader paths:
 *  - `data-testid="kb-add-doc-modal"` (dialog wrapper)
 *  - `data-testid="kb-add-doc-class"` (class select)
 *  - `data-testid="kb-add-doc-title"` (title input)
 *  - `data-testid="kb-add-doc-description"` (description textarea)
 *  - `data-testid="kb-add-doc-tag-input"` (tag chip input)
 *  - `data-testid="kb-add-doc-tag-suggestion"` (autocomplete option)
 *  - `data-testid="kb-add-doc-tag-chip"` (selected tag)
 *  - `data-testid="kb-add-doc-confirm"` (Create document button)
 *  - `data-testid="kb-add-doc-cancel"` (Cancel button)
 */
export function KbAddDocModal({
    workId,
    initialClass,
    onConfirm,
    onCancel,
    initialTags,
    busy = false,
    error = null,
}: KbAddDocModalProps) {
    const t = useTranslations('dashboard.workDetail.kb.addDoc');
    const tClassify = useTranslations('dashboard.workDetail.kb.classify');
    const tClasses = useTranslations('dashboard.workDetail.kb.classes');
    const headingId = useId();
    const [targetClass, setTargetClass] = useState<KbDocumentClass>(initialClass ?? 'freeform');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [tagInput, setTagInput] = useState('');
    const [allTags, setAllTags] = useState<KbTagDto[]>(initialTags ?? []);
    const [tagsError, setTagsError] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);

    // Fetch existing Work tags for autocomplete (same endpoint
    // `KbClassifyModal` uses).
    useEffect(() => {
        if (initialTags !== undefined) return;
        let cancelled = false;
        fetch(`/api/works/${workId}/kb/tags`, { credentials: 'same-origin' })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return (await res.json()) as KbTagDto[];
            })
            .then((rows) => {
                if (cancelled) return;
                setAllTags(rows);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setTagsError(err instanceof Error ? err.message : 'tags fetch failed');
            });
        return () => {
            cancelled = true;
        };
    }, [workId, initialTags]);

    // ESC closes the modal (mirrors KbClassifyModal).
    useEffect(() => {
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);

    const suggestions = useMemo(() => {
        const query = tagInput.trim().toLowerCase();
        if (query.length === 0) return [] as KbTagDto[];
        const selected = new Set(tags.map((tag) => tag.toLowerCase()));
        return allTags
            .filter(
                (tag) =>
                    !selected.has(tag.slug.toLowerCase()) &&
                    !selected.has(tag.name.toLowerCase()) &&
                    (tag.slug.toLowerCase().includes(query) ||
                        tag.name.toLowerCase().includes(query)),
            )
            .slice(0, 8);
    }, [tagInput, allTags, tags]);

    const addTag = useCallback((raw: string) => {
        const value = raw.trim();
        if (value.length === 0) return;
        setTags((prev) => (prev.includes(value) ? prev : [...prev, value]));
        setTagInput('');
    }, []);

    const onTagKeyDown = useCallback(
        (event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                addTag(tagInput);
            } else if (event.key === 'Backspace' && tagInput.length === 0 && tags.length > 0) {
                setTags((prev) => prev.slice(0, -1));
            }
        },
        [tagInput, tags.length, addTag],
    );

    const removeTag = useCallback((value: string) => {
        setTags((prev) => prev.filter((tag) => tag !== value));
    }, []);

    const trimmedTitle = title.trim();
    const canSubmit = !busy && trimmedTitle.length > 0;

    const onConfirmClick = useCallback(() => {
        if (!canSubmit) return;
        onConfirm({
            targetClass,
            title: trimmedTitle,
            description: description.trim(),
            tags,
        });
    }, [canSubmit, onConfirm, targetClass, trimmedTitle, description, tags]);

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            data-testid="kb-add-doc-modal"
            ref={dialogRef}
            className={cn('fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4')}
            onClick={(event) => {
                if (event.target === event.currentTarget && !busy) onCancel();
            }}
        >
            <div
                className={cn(
                    'w-full max-w-xl rounded-lg border border-border dark:border-border-dark',
                    // EW-639 dark-theme fix carried over from KbClassifyModal:
                    // `--color-card-primary-dark` is a 3% translucent
                    // overlay; using it as a modal panel makes the dialog
                    // see-through. `bg-card-dark` (#1e293b solid slate) is
                    // the elevated-surface convention used by shadcn
                    // `DialogContent` elsewhere.
                    'bg-card dark:bg-card-dark p-5 shadow-xl',
                    'flex flex-col gap-4',
                )}
            >
                <header className="flex flex-col gap-1">
                    <h2
                        id={headingId}
                        className="text-base font-semibold text-text dark:text-text-dark"
                    >
                        {t('title')}
                    </h2>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark/70">
                        {t('subtitle')}
                    </p>
                </header>

                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-text dark:text-text-dark">
                            {t('classLabel')}
                        </label>
                        <select
                            data-testid="kb-add-doc-class"
                            value={targetClass}
                            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                setTargetClass(event.target.value as KbDocumentClass)
                            }
                            disabled={busy}
                            className={cn(
                                'rounded-md border border-border dark:border-border-dark',
                                'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5 text-sm',
                            )}
                        >
                            {KB_DOCUMENT_CLASSES.map((cls) => (
                                <option key={cls} value={cls}>
                                    {tClasses(cls)}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-text dark:text-text-dark">
                            {t('titleLabel')}
                        </label>
                        <input
                            type="text"
                            data-testid="kb-add-doc-title"
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            placeholder={t('titlePlaceholder')}
                            autoFocus
                            disabled={busy}
                            className={cn(
                                'rounded-md border border-border dark:border-border-dark',
                                'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5 text-sm',
                            )}
                        />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-text dark:text-text-dark">
                            {t('descriptionLabel')}
                        </label>
                        <textarea
                            data-testid="kb-add-doc-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            rows={2}
                            disabled={busy}
                            className={cn(
                                'rounded-md border border-border dark:border-border-dark',
                                'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5 text-sm',
                            )}
                        />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-text dark:text-text-dark">
                            {t('tagsLabel')}
                        </label>
                        <div
                            className={cn(
                                'flex flex-wrap items-center gap-1.5 rounded-md border',
                                'border-border dark:border-border-dark',
                                'bg-card-secondary dark:bg-card-primary-dark/40 px-2 py-1.5 text-sm',
                            )}
                        >
                            {tags.map((tag) => (
                                <span
                                    key={tag}
                                    data-testid="kb-add-doc-tag-chip"
                                    className={cn(
                                        'inline-flex items-center gap-1 rounded-full',
                                        'bg-primary/10 text-primary px-2 py-0.5 text-xs',
                                    )}
                                >
                                    {tag}
                                    <button
                                        type="button"
                                        onClick={() => removeTag(tag)}
                                        aria-label={tClassify('removeTag', { tag })}
                                        disabled={busy}
                                        className="text-primary/70 hover:text-primary"
                                    >
                                        ×
                                    </button>
                                </span>
                            ))}
                            <input
                                data-testid="kb-add-doc-tag-input"
                                value={tagInput}
                                onChange={(event) => setTagInput(event.target.value)}
                                onKeyDown={onTagKeyDown}
                                placeholder={t('tagsPlaceholder')}
                                disabled={busy}
                                className="min-w-[6rem] flex-1 bg-transparent outline-none"
                            />
                        </div>
                        {suggestions.length > 0 ? (
                            <ul
                                data-testid="kb-add-doc-tag-suggestions"
                                className={cn(
                                    'mt-1 max-h-32 overflow-auto rounded-md border',
                                    'border-border dark:border-border-dark bg-card text-sm shadow',
                                )}
                            >
                                {suggestions.map((tag) => (
                                    <li key={tag.id}>
                                        <button
                                            type="button"
                                            data-testid="kb-add-doc-tag-suggestion"
                                            data-tag-slug={tag.slug}
                                            onClick={() => addTag(tag.slug)}
                                            className={cn(
                                                'flex w-full items-center gap-2 px-2 py-1 text-left',
                                                'hover:bg-card-hover dark:hover:bg-card-primary-dark/40',
                                            )}
                                        >
                                            <span>{tag.name}</span>
                                            <span className="text-xs text-text-muted">
                                                {tag.slug}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        {tagsError ? (
                            <p className="text-xs text-amber-700 dark:text-amber-300">
                                {tClassify('tagsFetchFailed', { error: tagsError })}
                            </p>
                        ) : null}
                    </div>
                </div>

                {error ? (
                    <p
                        role="alert"
                        data-testid="kb-add-doc-error"
                        className="text-xs text-red-600 dark:text-red-400"
                    >
                        {error}
                    </p>
                ) : null}

                <footer className="flex items-center justify-end gap-2 pt-2">
                    <Button
                        type="button"
                        data-testid="kb-add-doc-cancel"
                        onClick={onCancel}
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="button"
                        data-testid="kb-add-doc-confirm"
                        onClick={onConfirmClick}
                        size="sm"
                        disabled={!canSubmit}
                    >
                        {busy ? t('errorBusy') : t('confirm')}
                    </Button>
                </footer>
            </div>
        </div>
    );
}
