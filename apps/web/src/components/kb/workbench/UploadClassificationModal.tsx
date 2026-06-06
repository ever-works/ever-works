'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { KB_DOCUMENT_CLASSES } from '@ever-works/contracts';
import type { KbDocumentClass } from '@ever-works/contracts';
import { X } from 'lucide-react';

/**
 * EW-641 slice C — classification modal shown after a drop or after the
 * user clicks "Upload" in the Originals tab.
 *
 * The modal lets the operator confirm (or change) the inferred target
 * class, attach tags, write a description, and toggle auto-classify
 * before the upload starts. The parent (`WorkbenchUploadCoordinator`)
 * owns the actual upload state — this component only collects the
 * classification form and calls back with the validated input.
 *
 * Tags autocomplete is intentionally out of scope for slice C — the
 * modal accepts freeform tags via Enter or comma. Slice E will wire the
 * `/api/works/:id/kb/tags` autocomplete suggestion list.
 */

export interface UploadClassificationModalProps {
    /** Files queued for upload — rendered as a read-only preview list. */
    readonly files: readonly File[];
    /** Pre-fill — typically the drop-target's `data-kb-class`. */
    readonly defaultClass: KbDocumentClass;
    /** Fires when the user confirms. Parent runs `uploadKbFile` per file. */
    readonly onUpload: (input: UploadClassificationModalInput) => void;
    /** Fires when the user dismisses the modal without uploading. */
    readonly onCancel: () => void;
}

export interface UploadClassificationModalInput {
    readonly class: KbDocumentClass;
    readonly tags: readonly string[];
    readonly description: string;
    readonly autoClassify: boolean;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function UploadClassificationModal({
    files,
    defaultClass,
    onUpload,
    onCancel,
}: UploadClassificationModalProps) {
    const t = useTranslations('dashboard.workDetail.kb.workbench.upload');
    const tClass = useTranslations('dashboard.workDetail.kb.classes');

    const [targetClass, setTargetClass] = useState<KbDocumentClass>(defaultClass);
    const [tags, setTags] = useState<string[]>([]);
    const [tagDraft, setTagDraft] = useState('');
    const [description, setDescription] = useState('');
    const [autoClassify, setAutoClassify] = useState(false);

    useEffect(() => {
        // If the parent re-opens the modal with a different inferred
        // class (e.g. a second drop into a different group) we want the
        // selector to follow rather than stick on the previous value.
        setTargetClass(defaultClass);
    }, [defaultClass]);

    const canUpload = useMemo(
        () => Boolean(targetClass) && files.length > 0,
        [targetClass, files.length],
    );

    const addTag = (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) return;
        setTags((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
        setTagDraft('');
    };

    const removeTag = (tag: string) => {
        setTags((prev) => prev.filter((t) => t !== tag));
    };

    const handleTagKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
        if (ev.key === 'Enter' || ev.key === ',') {
            ev.preventDefault();
            addTag(tagDraft);
        } else if (ev.key === 'Backspace' && tagDraft === '' && tags.length > 0) {
            ev.preventDefault();
            const last = tags[tags.length - 1];
            removeTag(last);
        }
    };

    const handleUpload = () => {
        if (!canUpload) return;
        onUpload({
            class: targetClass,
            tags,
            description,
            autoClassify,
        });
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? null : onCancel())}>
            <DialogContent className="max-w-xl">
                <div data-testid="kb-workbench-upload-modal" className="flex flex-col gap-4">
                    <h2 className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('modal.title')}
                    </h2>

                    {/* File preview list */}
                    <ul
                        data-testid="kb-workbench-upload-modal-files"
                        className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded border border-border bg-card-hover/40 p-2 text-xs dark:border-border-dark dark:bg-card-primary-dark/30"
                    >
                        {files.map((file, idx) => (
                            <li
                                key={`${file.name}-${idx}`}
                                data-testid={`kb-workbench-upload-modal-file-${idx}`}
                                className="flex items-center gap-2"
                            >
                                <span className="truncate text-text dark:text-text-dark">
                                    {file.name}
                                </span>
                                <span className="text-text-muted dark:text-text-muted-dark/70">
                                    {file.type || 'application/octet-stream'}
                                </span>
                                <span className="ml-auto text-text-muted dark:text-text-muted-dark/70">
                                    {formatBytes(file.size)}
                                </span>
                            </li>
                        ))}
                    </ul>

                    {/* Target class chip selector */}
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark">
                            {t('modal.targetClass')}
                        </label>
                        <div
                            role="radiogroup"
                            aria-label={t('modal.targetClass')}
                            className="flex flex-wrap gap-1.5"
                        >
                            {KB_DOCUMENT_CLASSES.map((cls) => {
                                const active = targetClass === cls;
                                return (
                                    <button
                                        key={cls}
                                        type="button"
                                        role="radio"
                                        aria-checked={active}
                                        data-testid={`kb-workbench-upload-modal-class-${cls}`}
                                        data-active={active ? 'true' : 'false'}
                                        onClick={() => setTargetClass(cls)}
                                        className={cn(
                                            'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                                            active
                                                ? 'bg-primary text-button-primary-foreground dark:bg-primary dark:text-button-primary-foreground-dark'
                                                : 'bg-card-hover text-text-secondary hover:bg-card-hover/80 dark:bg-card-primary-dark/40 dark:text-text-secondary-dark/80',
                                        )}
                                    >
                                        {tClass(cls)}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Tags chip input */}
                    <div className="flex flex-col gap-1.5">
                        <label
                            htmlFor="kb-workbench-upload-modal-tag-input"
                            className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark"
                        >
                            {t('modal.tags')}
                        </label>
                        <div className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-surface px-2 py-1.5 dark:border-border-dark dark:bg-surface-dark">
                            {tags.map((tag) => (
                                <span
                                    key={tag}
                                    data-testid={`kb-workbench-upload-modal-tag-${tag}`}
                                    className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-text dark:bg-primary/20 dark:text-text-dark"
                                >
                                    {tag}
                                    <button
                                        type="button"
                                        onClick={() => removeTag(tag)}
                                        aria-label={`remove ${tag}`}
                                        data-testid={`kb-workbench-upload-modal-tag-remove-${tag}`}
                                        className="rounded-full text-text-muted hover:text-text dark:hover:text-text-dark"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </span>
                            ))}
                            <input
                                id="kb-workbench-upload-modal-tag-input"
                                data-testid="kb-workbench-upload-modal-tag-input"
                                type="text"
                                value={tagDraft}
                                onChange={(ev) => setTagDraft(ev.target.value)}
                                onKeyDown={handleTagKeyDown}
                                onBlur={() => {
                                    if (tagDraft.trim().length > 0) addTag(tagDraft);
                                }}
                                placeholder={t('modal.tagsPlaceholder')}
                                className="min-w-[8ch] flex-1 bg-transparent text-xs outline-none placeholder:text-text-muted dark:placeholder:text-text-muted-dark/60"
                            />
                        </div>
                    </div>

                    {/* Description textarea */}
                    <div className="flex flex-col gap-1.5">
                        <label
                            htmlFor="kb-workbench-upload-modal-description"
                            className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark"
                        >
                            {t('modal.description')}
                        </label>
                        <textarea
                            id="kb-workbench-upload-modal-description"
                            data-testid="kb-workbench-upload-modal-description"
                            value={description}
                            onChange={(ev) => setDescription(ev.target.value)}
                            rows={3}
                            placeholder={t('modal.descriptionPlaceholder')}
                            className="rounded border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary dark:border-border-dark dark:bg-surface-dark"
                        />
                    </div>

                    {/* Auto-classify checkbox */}
                    <label className="flex items-center gap-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                        <input
                            type="checkbox"
                            data-testid="kb-workbench-upload-modal-autoclassify"
                            checked={autoClassify}
                            onChange={(ev) => setAutoClassify(ev.target.checked)}
                            className="h-3.5 w-3.5"
                        />
                        <span>{t('modal.autoClassify')}</span>
                    </label>

                    {/* Footer actions */}
                    <div className="mt-2 flex items-center justify-end gap-2">
                        <Button
                            variant="ghost"
                            data-testid="kb-workbench-upload-modal-cancel"
                            onClick={onCancel}
                        >
                            {t('modal.cancel')}
                        </Button>
                        <Button
                            variant="primary"
                            data-testid="kb-workbench-upload-modal-upload"
                            disabled={!canUpload}
                            onClick={handleUpload}
                        >
                            {t('modal.upload')}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
