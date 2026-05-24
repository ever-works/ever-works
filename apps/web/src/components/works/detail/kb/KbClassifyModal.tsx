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

export interface KbClassifyFileEntry {
    /** Index into the original file array — caller maps back to the File. */
    index: number;
    name: string;
    /** Pretty title (defaults to filename without extension). */
    title: string;
}

export interface KbClassifyResult {
    targetClass: KbDocumentClass;
    description: string;
    tags: string[];
    /** Per-file titles, keyed by original index. */
    titles: Record<number, string>;
}

interface KbClassifyModalProps {
    workId: string;
    files: KbClassifyFileEntry[];
    /** Initial class (e.g. row dropped into a class folder in the tree). */
    initialClass?: KbDocumentClass;
    onConfirm: (result: KbClassifyResult) => void;
    onCancel: () => void;
    /**
     * Test seam: skip the network fetch + use the provided tag list.
     * Production code leaves this undefined so the modal fetches lazily.
     */
    initialTags?: KbTagDto[];
}

/**
 * EW-641 Phase 1B/d row 8 — Classification modal.
 *
 * Opens when the operator picks files via the upload zone. Per-batch
 * fields (`targetClass`, `description`, `tags`) apply to every file in
 * the batch; per-file `title` (default = filename minus extension) is
 * editable in the file list. Tags autocomplete from
 * `GET /api/works/:id/kb/tags` — the modal kicks the fetch lazily on
 * mount so the network round-trip overlaps with the user reading the
 * file list.
 *
 * Selectors locked for the Playwright A12 (drag-drop → KB doc)
 * acceptance suite:
 *  - `data-testid="kb-classify-modal"` (dialog wrapper)
 *  - `data-testid="kb-classify-class"` (class select)
 *  - `data-testid="kb-classify-description"` (description textarea)
 *  - `data-testid="kb-classify-tag-input"` (tag chip input)
 *  - `data-testid="kb-classify-tag-suggestion"` (autocomplete option)
 *  - `data-testid="kb-classify-tag-chip"` (selected tag)
 *  - `data-testid="kb-classify-file"` (file row)
 *  - `data-testid="kb-classify-confirm"` (upload button)
 *  - `data-testid="kb-classify-cancel"` (cancel button)
 *
 * Accessibility: dialog is rendered as `role="dialog"` with
 * `aria-modal="true"` and an `aria-labelledby` heading; ESC closes;
 * focus is trapped to the modal body on mount via the standard
 * `autoFocus` on the class select (the highest-impact field).
 */
export function KbClassifyModal({
    workId,
    files,
    initialClass,
    onConfirm,
    onCancel,
    initialTags,
}: KbClassifyModalProps) {
    const t = useTranslations('dashboard.workDetail.kb.classify');
    const tClasses = useTranslations('dashboard.workDetail.kb.classes');
    const headingId = useId();
    const [targetClass, setTargetClass] = useState<KbDocumentClass>(initialClass ?? 'freeform');
    const [description, setDescription] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [tagInput, setTagInput] = useState('');
    const [titles, setTitles] = useState<Record<number, string>>(() =>
        Object.fromEntries(files.map((f) => [f.index, f.title])),
    );
    const [allTags, setAllTags] = useState<KbTagDto[]>(initialTags ?? []);
    const [tagsError, setTagsError] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);

    // Fetch existing Work tags for autocomplete.
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
            .catch((error: unknown) => {
                if (cancelled) return;
                setTagsError(error instanceof Error ? error.message : 'tags fetch failed');
            });
        return () => {
            cancelled = true;
        };
    }, [workId, initialTags]);

    // ESC closes the modal.
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
        const selected = new Set(tags.map((t) => t.toLowerCase()));
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

    const onTitleChange = useCallback((index: number, value: string) => {
        setTitles((prev) => ({ ...prev, [index]: value }));
    }, []);

    const onConfirmClick = useCallback(() => {
        onConfirm({
            targetClass,
            description: description.trim(),
            tags,
            titles,
        });
    }, [onConfirm, targetClass, description, tags, titles]);

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            data-testid="kb-classify-modal"
            ref={dialogRef}
            className={cn('fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4')}
            onClick={(event) => {
                if (event.target === event.currentTarget) onCancel();
            }}
        >
            <div
                className={cn(
                    'w-full max-w-xl rounded-lg border border-border dark:border-border-dark',
                    // EW-639 dark-theme fix: `--color-card-primary-dark`
                    // resolves to `#ffffff08` (a 3% translucent overlay,
                    // intended for cards that sit on top of solid page
                    // chrome). Using it as the modal panel background
                    // made the dialog see-through in dark mode — the
                    // page content behind the `bg-black/40` overlay
                    // bled through. `bg-card-dark` (#1e293b, solid
                    // slate) matches the elevated-surface convention
                    // used by the shadcn `DialogContent` primitive
                    // elsewhere in the app.
                    'bg-card dark:bg-card-dark p-5 shadow-xl',
                    'flex flex-col gap-4',
                )}
            >
                <header className="flex flex-col gap-1">
                    <h2
                        id={headingId}
                        className="text-base font-semibold text-text dark:text-text-dark"
                    >
                        {t('title', { count: files.length })}
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
                            data-testid="kb-classify-class"
                            value={targetClass}
                            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                                setTargetClass(event.target.value as KbDocumentClass)
                            }
                            autoFocus
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
                            {t('descriptionLabel')}
                        </label>
                        <textarea
                            data-testid="kb-classify-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            rows={2}
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
                                    data-testid="kb-classify-tag-chip"
                                    className={cn(
                                        'inline-flex items-center gap-1 rounded-full',
                                        'bg-primary/10 text-primary px-2 py-0.5 text-xs',
                                    )}
                                >
                                    {tag}
                                    <button
                                        type="button"
                                        onClick={() => removeTag(tag)}
                                        aria-label={t('removeTag', { tag })}
                                        className="text-primary/70 hover:text-primary"
                                    >
                                        ×
                                    </button>
                                </span>
                            ))}
                            <input
                                data-testid="kb-classify-tag-input"
                                value={tagInput}
                                onChange={(event) => setTagInput(event.target.value)}
                                onKeyDown={onTagKeyDown}
                                placeholder={t('tagsPlaceholder')}
                                className="min-w-[6rem] flex-1 bg-transparent outline-none"
                            />
                        </div>
                        {suggestions.length > 0 ? (
                            <ul
                                data-testid="kb-classify-tag-suggestions"
                                className={cn(
                                    'mt-1 max-h-32 overflow-auto rounded-md border',
                                    'border-border dark:border-border-dark bg-card text-sm shadow',
                                )}
                            >
                                {suggestions.map((tag) => (
                                    <li key={tag.id}>
                                        <button
                                            type="button"
                                            data-testid="kb-classify-tag-suggestion"
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
                                {t('tagsFetchFailed', { error: tagsError })}
                            </p>
                        ) : null}
                    </div>

                    <ul className="flex flex-col gap-1.5" data-testid="kb-classify-files">
                        {files.map((file) => (
                            <li
                                key={file.index}
                                data-testid="kb-classify-file"
                                data-file-index={file.index}
                                className={cn(
                                    'flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs',
                                    'border-border dark:border-border-dark',
                                    'bg-card/30 dark:bg-card-primary-dark/20',
                                )}
                            >
                                <span className="text-text-muted dark:text-text-muted-dark/70">
                                    {file.name}
                                </span>
                                <input
                                    aria-label={t('titleLabel')}
                                    data-testid="kb-classify-file-title"
                                    value={titles[file.index] ?? file.title}
                                    onChange={(event) =>
                                        onTitleChange(file.index, event.target.value)
                                    }
                                    className={cn(
                                        'ml-auto flex-1 rounded border border-border/60',
                                        'dark:border-border-dark/60 bg-transparent px-2 py-0.5',
                                    )}
                                />
                            </li>
                        ))}
                    </ul>
                </div>

                <footer className="flex items-center justify-end gap-2 pt-2">
                    <Button
                        type="button"
                        data-testid="kb-classify-cancel"
                        onClick={onCancel}
                        variant="ghost"
                        size="sm"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        type="button"
                        data-testid="kb-classify-confirm"
                        onClick={onConfirmClick}
                        size="sm"
                    >
                        {t('confirm', { count: files.length })}
                    </Button>
                </footer>
            </div>
        </div>
    );
}
