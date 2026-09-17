'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { CornerUpLeft, FolderClosed, FolderPlus, Loader2, Search } from 'lucide-react';
import { KB_LIBRARY_FILE_BATCH_MAX } from '@ever-works/contracts';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { flattenLibraryFolders, type KbLibraryTreeDto } from '@/lib/api/knowledge-library-types';
import { cn } from '@/lib/utils/cn';

/** What the picker files into: a shared folder id, or `null` for Unfiled. */
export type FolderPickerTarget = string | null;

type PickerOption =
    | { kind: 'folder'; id: string; name: string; depth: number }
    | { kind: 'unfiled' }
    | { kind: 'create'; name: string };

export interface FolderPickerDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** How many documents are being filed — drives the title and the batch cap. */
    documentCount: number;
    /** The folder rail; `null` while it loads. */
    tree: KbLibraryTreeDto | null;
    /** The folder the documents are in today, marked in the list. */
    currentFolderId?: string | null;
    /** File into the chosen target. Rejecting keeps the dialog open with `error`. */
    onFile: (target: FolderPickerTarget) => Promise<void>;
    /** Create a shared folder by name at the top level; resolves with its id. */
    onCreateFolder?: (name: string) => Promise<string>;
    /** A message to show under the list (a failed file or create). */
    error?: string | null;
}

/**
 * "File into folder…" — choose a shared folder (or Unfiled) for one or many
 * documents. Typing filters the folders by name; when nothing matches the
 * name exactly and the person may manage shared folders, the last option
 * creates that folder and files into it in one step.
 *
 * Keyboard: ↑/↓ move, Enter files into the highlighted option, Esc cancels.
 * Focus stays in the search box, which is the combobox owning the list, so
 * `aria-activedescendant` names the highlighted option — a screen reader
 * announces the folder Enter would file into instead of leaving it silent.
 * More than `KB_LIBRARY_FILE_BATCH_MAX` documents cannot be filed at once;
 * the dialog says so and disables File rather than sending a doomed request.
 */
export function FolderPickerDialog({
    open,
    onOpenChange,
    documentCount,
    tree,
    currentFolderId,
    onFile,
    onCreateFolder,
    error,
}: FolderPickerDialogProps) {
    const t = useTranslations('dashboard.memoryPage.library');
    const baseId = useId();
    const listboxId = `${baseId}-list`;
    const optionId = (option: PickerOption) =>
        `${baseId}-opt-${option.kind === 'folder' ? option.id : option.kind}`;
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [chosen, setChosen] = useState<PickerOption | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Folders this dialog already created, by case-folded name. When filing
    // fails after the folder was made, File retries into that folder instead
    // of creating it again.
    const createdIds = useRef(new Map<string, string>());

    useEffect(() => {
        if (!open) return;
        setQuery('');
        setActive(0);
        setChosen(null);
        setIsSubmitting(false);
        createdIds.current = new Map();
    }, [open]);

    const options = useMemo<PickerOption[]>(() => {
        const trimmed = query.trim();
        const needle = trimmed.toLowerCase();
        const folders = flattenLibraryFolders(tree?.folders ?? []);
        const matching = needle
            ? folders.filter((f) => f.name.toLowerCase().includes(needle))
            : folders;
        const list: PickerOption[] = matching.map((f) => ({
            kind: 'folder',
            id: f.id,
            name: f.name,
            // A filtered list reads flat; the browse list keeps its nesting.
            depth: needle ? 1 : f.depth,
        }));
        list.push({ kind: 'unfiled' });
        const exact = folders.some((f) => f.name.toLowerCase() === needle);
        if (trimmed && !exact && onCreateFolder && tree?.canManageFolders) {
            list.push({ kind: 'create', name: trimmed });
        }
        return list;
    }, [query, tree, onCreateFolder]);

    const overLimit = documentCount > KB_LIBRARY_FILE_BATCH_MAX;
    const highlighted = options[Math.min(active, options.length - 1)] ?? null;

    const submit = async (option: PickerOption | null) => {
        if (!option || overLimit || isSubmitting) return;
        setIsSubmitting(true);
        try {
            if (option.kind === 'create') {
                const key = option.name.toLowerCase();
                let id = createdIds.current.get(key);
                if (!id) {
                    if (!onCreateFolder) return;
                    id = await onCreateFolder(option.name);
                    createdIds.current.set(key, id);
                    // The folder exists now: a retry files into it.
                    setChosen({ kind: 'folder', id, name: option.name, depth: 1 });
                }
                await onFile(id);
            } else {
                await onFile(option.kind === 'folder' ? option.id : null);
            }
        } catch {
            // The caller reports the failure through `error`; stay open.
        } finally {
            setIsSubmitting(false);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((i) => Math.min(i + 1, options.length - 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            setChosen(highlighted);
            void submit(highlighted);
        }
    };

    const requestClose = (next: boolean) => {
        if (!next && isSubmitting) return;
        onOpenChange(next);
    };

    const isChosen = (option: PickerOption) =>
        chosen !== null &&
        chosen.kind === option.kind &&
        (option.kind !== 'folder' || (chosen.kind === 'folder' && chosen.id === option.id));

    return (
        <Dialog open={open} onOpenChange={requestClose}>
            <DialogContent className="max-w-md p-0">
                <div data-testid="library-folder-picker" onKeyDown={onKeyDown}>
                    <div className="border-b border-card-border dark:border-white/9 px-4 py-3">
                        <DialogTitle className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('fileIntoTitle', { count: documentCount })}
                        </DialogTitle>
                    </div>
                    <div className="px-4 pt-3">
                        <div className="relative">
                            <Search
                                className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted dark:text-text-muted-dark"
                                strokeWidth={1.5}
                                aria-hidden="true"
                            />
                            <input
                                data-testid="library-folder-picker-search"
                                type="text"
                                role="combobox"
                                aria-expanded="true"
                                aria-autocomplete="list"
                                aria-controls={listboxId}
                                aria-activedescendant={
                                    highlighted ? optionId(highlighted) : undefined
                                }
                                autoFocus
                                value={query}
                                onChange={(e) => {
                                    setQuery(e.target.value);
                                    setActive(0);
                                }}
                                placeholder={t('fileIntoSearch')}
                                aria-label={t('fileIntoSearch')}
                                className={cn(
                                    'w-full rounded-lg border py-2 pl-8 pr-3 text-sm outline-none',
                                    'border-card-border bg-card dark:border-white/9 dark:bg-card-primary-dark',
                                    'text-text dark:text-text-dark focus:border-primary',
                                )}
                            />
                        </div>
                    </div>
                    <ul
                        id={listboxId}
                        role="listbox"
                        aria-label={t('fileIntoTitle', { count: documentCount })}
                        className="max-h-72 overflow-y-auto px-2 py-2"
                    >
                        {tree === null ? (
                            <li className="flex items-center gap-2 px-2 py-2 text-sm text-text-muted dark:text-text-muted-dark">
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                {t('loading')}
                            </li>
                        ) : null}
                        {tree !== null && tree.folders.length === 0 && !query.trim() ? (
                            <li className="px-2 py-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('fileIntoNoFolders')}
                            </li>
                        ) : null}
                        {options.map((option, index) => {
                            const selected = isChosen(option);
                            const isActive = highlighted === option;
                            const key = option.kind === 'folder' ? option.id : `__${option.kind}`;
                            return (
                                <li key={key} role="presentation">
                                    <button
                                        type="button"
                                        role="option"
                                        id={optionId(option)}
                                        aria-selected={selected}
                                        data-testid={
                                            option.kind === 'folder'
                                                ? `library-folder-picker-option-${option.id}`
                                                : `library-folder-picker-${option.kind}`
                                        }
                                        onMouseEnter={() => setActive(index)}
                                        onClick={() => setChosen(option)}
                                        onDoubleClick={() => void submit(option)}
                                        style={
                                            option.kind === 'folder'
                                                ? {
                                                      paddingLeft: `${0.5 + (option.depth - 1) * 1}rem`,
                                                  }
                                                : undefined
                                        }
                                        className={cn(
                                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                                            'text-text dark:text-text-dark',
                                            isActive && 'bg-surface-secondary dark:bg-white/5',
                                            selected && 'ring-1 ring-primary/50 bg-primary/10',
                                        )}
                                    >
                                        {option.kind === 'folder' ? (
                                            <>
                                                <FolderClosed
                                                    className="h-4 w-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                                    strokeWidth={1.5}
                                                    aria-hidden="true"
                                                />
                                                <span className="truncate">{option.name}</span>
                                                {currentFolderId === option.id ? (
                                                    <span className="ml-auto text-[10px] uppercase text-text-muted dark:text-text-muted-dark">
                                                        {t('fileIntoCurrent')}
                                                    </span>
                                                ) : null}
                                            </>
                                        ) : option.kind === 'unfiled' ? (
                                            <>
                                                <CornerUpLeft
                                                    className="h-4 w-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                                    strokeWidth={1.5}
                                                    aria-hidden="true"
                                                />
                                                <span>{t('fileIntoUnfiled')}</span>
                                            </>
                                        ) : (
                                            <>
                                                <FolderPlus
                                                    className="h-4 w-4 shrink-0 text-primary"
                                                    strokeWidth={1.5}
                                                    aria-hidden="true"
                                                />
                                                <span className="truncate">
                                                    {t('fileIntoNewFolder', { name: option.name })}
                                                </span>
                                            </>
                                        )}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    {overLimit ? (
                        <p
                            data-testid="library-folder-picker-over-limit"
                            role="alert"
                            className="px-4 pb-2 text-xs text-red-600 dark:text-red-400"
                        >
                            {t('fileBatchLimit', {
                                max: KB_LIBRARY_FILE_BATCH_MAX,
                                count: documentCount,
                            })}
                        </p>
                    ) : null}
                    {error ? (
                        <p
                            data-testid="library-folder-picker-error"
                            role="alert"
                            className="px-4 pb-2 text-xs text-red-600 dark:text-red-400"
                        >
                            {error}
                        </p>
                    ) : null}
                    <div className="flex items-center justify-end gap-2 border-t border-card-border dark:border-white/9 px-4 py-3">
                        <button
                            type="button"
                            data-testid="library-folder-picker-cancel"
                            onClick={() => requestClose(false)}
                            disabled={isSubmitting}
                            className="rounded-lg px-3 py-1.5 text-sm text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-white/5 disabled:opacity-50"
                        >
                            {t('cancel')}
                        </button>
                        <button
                            type="button"
                            data-testid="library-folder-picker-confirm"
                            onClick={() => void submit(chosen)}
                            disabled={chosen === null || overLimit || isSubmitting}
                            className={cn(
                                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium',
                                'bg-primary text-white hover:bg-primary/90 dark:bg-white dark:text-gray-900 dark:hover:bg-white/90',
                                'disabled:cursor-not-allowed disabled:opacity-50',
                            )}
                        >
                            {isSubmitting ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : null}
                            {t('fileIntoConfirm')}
                        </button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
