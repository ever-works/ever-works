'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
    Archive,
    ChevronDown,
    ChevronRight,
    FolderClosed,
    FolderPlus,
    Inbox,
    Library,
    Loader2,
    MoreHorizontal,
    Pencil,
    Trash2,
} from 'lucide-react';
import {
    KB_LIBRARY_FOLDER_MAX_DEPTH,
    KB_LIBRARY_FOLDER_NAME_MAX,
    KB_LIBRARY_FOLDERS_MAX_PER_ORG,
} from '@ever-works/contracts';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { KbLibraryFolderNodeDto, KbLibraryTreeDto } from '@/lib/api/knowledge-library-types';
import { cn } from '@/lib/utils/cn';
import { folderErrorKey } from './library-client';
import { RowMenuItem } from './LibraryDocumentRow';

/** What the shelf is showing. */
export type LibrarySelection =
    | { kind: 'all' }
    | { kind: 'unfiled' }
    | { kind: 'archived' }
    | { kind: 'folder'; id: string };

export interface LibraryFolderRailProps {
    tree: KbLibraryTreeDto | null;
    state: 'loading' | 'ready' | 'error';
    selection: LibrarySelection;
    onSelect: (selection: LibrarySelection) => void;
    onRetry: () => void;
    onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
    onRenameFolder: (folderId: string, name: string) => Promise<void>;
    onDeleteFolder: (folderId: string) => Promise<void>;
    /** Bumped by the parent to open the top-level New folder dialog. */
    createRequest?: number;
}

type NameDialog =
    | { mode: 'create'; parent: KbLibraryFolderNodeDto | null }
    | { mode: 'rename'; folder: KbLibraryFolderNodeDto };

/**
 * The library's folder rail: All documents, the shared folder tree with
 * document counts, Unfiled, and the Archived view — plus New folder and a
 * per-folder menu (Rename…, New subfolder…, Delete folder…).
 *
 * Folder writes need organization admin access; everyone else sees the same
 * controls disabled with the reason. The 5-level depth cap disables New
 * subfolder at the deepest level, and the 500-folder cap disables New folder
 * with a note. Deleting a folder never deletes a document — they move to
 * Unfiled, which the confirmation says in so many words.
 */
export function LibraryFolderRail({
    tree,
    state,
    selection,
    onSelect,
    onRetry,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    createRequest = 0,
}: LibraryFolderRailProps) {
    const t = useTranslations('dashboard.memoryPage.library');
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<KbLibraryFolderNodeDto | null>(null);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [dialogError, setDialogError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const lastCreateRequest = useRef(createRequest);

    const canManage = tree?.canManageFolders ?? false;
    const atFolderLimit = (tree?.folderCount ?? 0) >= KB_LIBRARY_FOLDERS_MAX_PER_ORG;

    // Top-level folders open by default so their children are one click away.
    useEffect(() => {
        if (!tree) return;
        setExpanded((prev) => {
            if (prev.size > 0) return prev;
            return new Set(tree.folders.map((f) => f.id));
        });
    }, [tree]);

    useEffect(() => {
        if (createRequest === lastCreateRequest.current) return;
        lastCreateRequest.current = createRequest;
        if (canManage && !atFolderLimit) {
            setDialogError(null);
            setNameDialog({ mode: 'create', parent: null });
        }
    }, [createRequest, canManage, atFolderLimit]);

    const toggle = (id: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const runDialog = async (work: () => Promise<void>) => {
        setPending(true);
        setDialogError(null);
        try {
            await work();
            setNameDialog(null);
            setDeleteTarget(null);
        } catch (error) {
            const key = folderErrorKey(error);
            const max =
                key === 'folderLimitReached'
                    ? KB_LIBRARY_FOLDERS_MAX_PER_ORG
                    : key === 'folderDepthLimit'
                      ? KB_LIBRARY_FOLDER_MAX_DEPTH
                      : KB_LIBRARY_FOLDER_NAME_MAX;
            setDialogError(t(key, { max }));
        } finally {
            setPending(false);
        }
    };

    const isSelected = (candidate: LibrarySelection) =>
        selection.kind === candidate.kind &&
        (candidate.kind !== 'folder' ||
            (selection.kind === 'folder' && selection.id === candidate.id));

    const renderFolder = (node: KbLibraryFolderNodeDto) => {
        const open = expanded.has(node.id);
        const Chevron = open ? ChevronDown : ChevronRight;
        const atDepthLimit = node.depth >= KB_LIBRARY_FOLDER_MAX_DEPTH;
        const manageReason = canManage ? undefined : t('noManageFolders');
        return (
            <li key={node.id} data-testid={`library-folder-${node.id}`}>
                <div
                    className="relative flex items-center"
                    onContextMenu={(event) => {
                        event.preventDefault();
                        setMenuFor(node.id);
                    }}
                >
                    {node.children.length > 0 ? (
                        <button
                            type="button"
                            data-testid={`library-folder-toggle-${node.id}`}
                            aria-expanded={open}
                            aria-label={t(open ? 'collapseFolder' : 'expandFolder', {
                                name: node.name,
                            })}
                            onClick={() => toggle(node.id)}
                            className="inline-flex h-6 w-5 shrink-0 items-center justify-center text-text-muted dark:text-text-muted-dark"
                        >
                            <Chevron className="h-3 w-3" aria-hidden="true" />
                        </button>
                    ) : (
                        <span className="w-5 shrink-0" aria-hidden="true" />
                    )}
                    <RailButton
                        testId={`library-folder-select-${node.id}`}
                        active={isSelected({ kind: 'folder', id: node.id })}
                        icon={
                            <FolderClosed
                                className="h-4 w-4"
                                strokeWidth={1.5}
                                aria-hidden="true"
                            />
                        }
                        label={node.name}
                        count={node.subtreeDocumentCount}
                        onClick={() => onSelect({ kind: 'folder', id: node.id })}
                    />
                    <button
                        type="button"
                        data-testid={`library-folder-menu-${node.id}`}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === node.id}
                        aria-label={t('folderOptions', { name: node.name })}
                        onClick={() =>
                            setMenuFor((current) => (current === node.id ? null : node.id))
                        }
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted opacity-70 hover:bg-surface-secondary hover:opacity-100 dark:text-text-muted-dark dark:hover:bg-white/5"
                    >
                        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    {menuFor === node.id ? (
                        <FolderMenu onClose={() => setMenuFor(null)}>
                            <RowMenuItem
                                testId={`library-folder-rename-${node.id}`}
                                icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
                                label={t('folderRename')}
                                disabled={!canManage}
                                disabledReason={manageReason}
                                onClick={() => {
                                    setMenuFor(null);
                                    setDialogError(null);
                                    setNameDialog({ mode: 'rename', folder: node });
                                }}
                            />
                            <RowMenuItem
                                testId={`library-folder-new-sub-${node.id}`}
                                icon={<FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />}
                                label={t('folderNewSub')}
                                disabled={!canManage || atDepthLimit || atFolderLimit}
                                disabledReason={
                                    manageReason ??
                                    (atDepthLimit
                                        ? t('folderDepthLimit', {
                                              max: KB_LIBRARY_FOLDER_MAX_DEPTH,
                                          })
                                        : atFolderLimit
                                          ? t('folderLimitReached', {
                                                max: KB_LIBRARY_FOLDERS_MAX_PER_ORG,
                                            })
                                          : undefined)
                                }
                                onClick={() => {
                                    setMenuFor(null);
                                    setDialogError(null);
                                    setNameDialog({ mode: 'create', parent: node });
                                }}
                            />
                            <RowMenuItem
                                testId={`library-folder-delete-${node.id}`}
                                icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                                label={t('folderDelete')}
                                disabled={!canManage}
                                disabledReason={manageReason}
                                onClick={() => {
                                    setMenuFor(null);
                                    setDialogError(null);
                                    setDeleteTarget(node);
                                }}
                            />
                        </FolderMenu>
                    ) : null}
                </div>
                {open && node.children.length > 0 ? (
                    <ul className="ml-3 border-l border-card-border pl-1 dark:border-white/9">
                        {node.children.map(renderFolder)}
                    </ul>
                ) : null}
            </li>
        );
    };

    return (
        <nav
            data-testid="library-folder-rail"
            aria-label={t('folders')}
            className="flex flex-col gap-1 text-sm"
        >
            {state === 'loading' && !tree ? (
                <div data-testid="library-folder-rail-loading" className="flex flex-col gap-2 p-1">
                    {[0, 1, 2, 3].map((i) => (
                        <span
                            key={i}
                            className="h-5 animate-pulse rounded bg-surface-secondary dark:bg-white/5"
                            style={{ width: `${80 - i * 12}%` }}
                        />
                    ))}
                </div>
            ) : state === 'error' && !tree ? (
                <div
                    data-testid="library-folder-rail-error"
                    role="alert"
                    className="flex flex-col items-start gap-2 p-2 text-xs text-text dark:text-text-dark"
                >
                    <p>{t('treeLoadFailed')}</p>
                    <button
                        type="button"
                        onClick={onRetry}
                        className="rounded-md border border-card-border px-2 py-1 dark:border-white/9"
                    >
                        {t('tryAgain')}
                    </button>
                </div>
            ) : (
                <>
                    <RailButton
                        testId="library-rail-all"
                        active={isSelected({ kind: 'all' })}
                        icon={<Library className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
                        label={t('allDocuments')}
                        count={tree?.documentCount ?? 0}
                        onClick={() => onSelect({ kind: 'all' })}
                    />
                    {tree && tree.folders.length > 0 ? (
                        <ul className="flex flex-col gap-0.5">{tree.folders.map(renderFolder)}</ul>
                    ) : null}
                    <RailButton
                        testId="library-rail-unfiled"
                        active={isSelected({ kind: 'unfiled' })}
                        icon={<Inbox className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
                        label={t('unfiled')}
                        count={tree?.unfiled.documentCount ?? 0}
                        onClick={() => onSelect({ kind: 'unfiled' })}
                    />
                    <p className="mt-3 px-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted dark:text-text-muted-dark">
                        {t('views')}
                    </p>
                    <RailButton
                        testId="library-rail-archived"
                        active={isSelected({ kind: 'archived' })}
                        icon={<Archive className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
                        label={t('archivedView')}
                        count={tree?.archivedCount ?? 0}
                        onClick={() => onSelect({ kind: 'archived' })}
                    />
                    <button
                        type="button"
                        data-testid="library-new-folder"
                        aria-disabled={!canManage || atFolderLimit}
                        title={!canManage ? t('noManageFolders') : undefined}
                        onClick={() => {
                            if (!canManage || atFolderLimit) return;
                            setDialogError(null);
                            setNameDialog({ mode: 'create', parent: null });
                        }}
                        className={cn(
                            'mt-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-text dark:text-text-dark',
                            'hover:bg-surface-secondary dark:hover:bg-white/5',
                            (!canManage || atFolderLimit) && 'cursor-not-allowed opacity-50',
                        )}
                    >
                        <FolderPlus className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                        {t('newFolder')}
                    </button>
                    {atFolderLimit ? (
                        <p
                            data-testid="library-folder-limit"
                            className="px-2 text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {t('folderLimitReached', { max: KB_LIBRARY_FOLDERS_MAX_PER_ORG })}
                        </p>
                    ) : null}
                </>
            )}

            <FolderNameDialog
                key={
                    nameDialog === null
                        ? 'closed'
                        : nameDialog.mode === 'rename'
                          ? `rename:${nameDialog.folder.id}`
                          : `create:${nameDialog.parent?.id ?? 'root'}`
                }
                dialog={nameDialog}
                pending={pending}
                error={dialogError}
                onCancel={() => setNameDialog(null)}
                onSubmit={(name) =>
                    void runDialog(() =>
                        nameDialog?.mode === 'rename'
                            ? onRenameFolder(nameDialog.folder.id, name)
                            : onCreateFolder(name, nameDialog?.parent?.id ?? null),
                    )
                }
            />

            <Dialog
                open={deleteTarget !== null}
                onOpenChange={(open) => {
                    if (!open && !pending) setDeleteTarget(null);
                }}
            >
                <DialogContent className="max-w-md">
                    <div data-testid="library-folder-delete-dialog" className="flex flex-col gap-3">
                        <DialogTitle className="text-sm font-semibold text-text dark:text-text-dark">
                            {t('folderDelete')}
                        </DialogTitle>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('folderDeleteConfirm', { name: deleteTarget?.name ?? '' })}
                        </p>
                        {dialogError ? (
                            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                                {dialogError}
                            </p>
                        ) : null}
                        <div className="flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setDeleteTarget(null)}
                                disabled={pending}
                                className="rounded-lg px-3 py-1.5 text-sm text-text hover:bg-surface-secondary dark:text-text-dark dark:hover:bg-white/5"
                            >
                                {t('cancel')}
                            </button>
                            <button
                                type="button"
                                data-testid="library-folder-delete-confirm"
                                disabled={pending}
                                onClick={() => {
                                    const target = deleteTarget;
                                    if (target) void runDialog(() => onDeleteFolder(target.id));
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
                            >
                                {pending ? (
                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                ) : null}
                                {t('folderDeleteAction')}
                            </button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </nav>
    );
}

function RailButton({
    testId,
    active,
    icon,
    label,
    count,
    onClick,
}: {
    testId: string;
    active: boolean;
    icon: ReactNode;
    label: string;
    count: number;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            data-testid={testId}
            aria-current={active ? 'true' : undefined}
            onClick={onClick}
            className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                active
                    ? 'bg-primary/10 text-text dark:bg-primary/20 dark:text-text-dark'
                    : 'text-text-secondary hover:bg-surface-secondary dark:text-text-secondary-dark/80 dark:hover:bg-white/5',
            )}
        >
            <span className="shrink-0 text-text-muted dark:text-text-muted-dark">{icon}</span>
            <span className="truncate">{label}</span>
            <span className="ml-auto shrink-0 text-xs text-text-muted dark:text-text-muted-dark">
                {count}
            </span>
        </button>
    );
}

function FolderMenu({ children, onClose }: { children: ReactNode; onClose: () => void }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const onDown = (event: MouseEvent) => {
            // The row holds the menu AND its toggle button; a press on either
            // is not an outside click (the toggle closes the menu itself).
            const row = ref.current?.parentElement;
            if (event.target instanceof Node && row?.contains(event.target)) return;
            onClose();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);
    return (
        <div
            ref={ref}
            role="menu"
            className="absolute right-0 top-7 z-20 min-w-[12rem] rounded-md border border-border bg-surface p-1 shadow-lg dark:border-border-dark dark:bg-surface-dark"
        >
            {children}
        </div>
    );
}

function FolderNameDialog({
    dialog,
    pending,
    error,
    onCancel,
    onSubmit,
}: {
    dialog: NameDialog | null;
    pending: boolean;
    error: string | null;
    onCancel: () => void;
    onSubmit: (name: string) => void;
}) {
    const t = useTranslations('dashboard.memoryPage.library');
    // The parent remounts the dialog (a new `key`) for every opening, so the
    // field starts from the folder being renamed, or empty for a new one.
    const [name, setName] = useState(() => (dialog?.mode === 'rename' ? dialog.folder.name : ''));

    const trimmed = name.trim();
    const tooLong = trimmed.length > KB_LIBRARY_FOLDER_NAME_MAX;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!trimmed || tooLong || pending) return;
        onSubmit(trimmed);
    };

    const title =
        dialog?.mode === 'rename'
            ? t('folderRename')
            : dialog?.parent
              ? t('folderNewSub')
              : t('newFolder');

    return (
        <Dialog
            open={dialog !== null}
            onOpenChange={(open) => {
                if (!open && !pending) onCancel();
            }}
        >
            <DialogContent className="max-w-md">
                <form
                    data-testid="library-folder-name-dialog"
                    onSubmit={submit}
                    className="flex flex-col gap-3"
                >
                    <DialogTitle className="text-sm font-semibold text-text dark:text-text-dark">
                        {title}
                    </DialogTitle>
                    <input
                        data-testid="library-folder-name-input"
                        type="text"
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('folderNamePlaceholder')}
                        aria-label={t('folderNamePlaceholder')}
                        maxLength={KB_LIBRARY_FOLDER_NAME_MAX + 1}
                        disabled={pending}
                        className="rounded-lg border border-card-border bg-card px-3 py-2 text-sm text-text outline-none focus:border-primary dark:border-white/9 dark:bg-card-primary-dark dark:text-text-dark"
                    />
                    {tooLong ? (
                        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                            {t('folderNameLength', { max: KB_LIBRARY_FOLDER_NAME_MAX })}
                        </p>
                    ) : null}
                    {error ? (
                        <p
                            data-testid="library-folder-name-error"
                            role="alert"
                            className="text-xs text-red-600 dark:text-red-400"
                        >
                            {error}
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={pending}
                            className="rounded-lg px-3 py-1.5 text-sm text-text hover:bg-surface-secondary dark:text-text-dark dark:hover:bg-white/5"
                        >
                            {t('cancel')}
                        </button>
                        <button
                            type="submit"
                            data-testid="library-folder-name-submit"
                            disabled={!trimmed || tooLong || pending}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50 dark:bg-white dark:text-gray-900"
                        >
                            {pending ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : null}
                            {dialog?.mode === 'rename' ? t('folderSave') : t('folderCreate')}
                        </button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
