'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Info, Library, Loader2, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import {
    KB_DOCUMENT_CLASSES,
    KB_LIBRARY_FILE_BATCH_MAX,
    type KbDocumentClass,
    type KbLibrarySort,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { useWorkspaceScope } from '@/lib/hooks/use-workspace-scope';
import {
    formatFolderPath,
    type KbLibraryDocumentDto,
    type KbLibraryListQuery,
    type KbLibraryTreeDto,
    type KnowledgeLibraryInitialData,
} from '@/lib/api/knowledge-library-types';
import { FolderPickerDialog, type FolderPickerTarget } from './FolderPickerDialog';
import { LibraryArchivedPanel } from './LibraryArchivedPanel';
import { LibraryDocumentList } from './LibraryDocumentList';
import { LibraryFolderRail, type LibrarySelection } from './LibraryFolderRail';
import { LibraryRequestError, knowledgeLibraryClient } from './library-client';

/** A Work the shelf can be narrowed to. */
export interface LibraryWorkOption {
    value: string;
    label: string;
}

export interface LibraryPanelProps {
    /** Server-rendered first page and folder rail (a `?view=library` deep link). */
    initial?: KnowledgeLibraryInitialData;
    /** Work filter options — the Works the Memory aggregation already covers. */
    works?: LibraryWorkOption[];
}

type LoadState = 'loading' | 'ready' | 'error';

const SORT_STORAGE_KEY = 'knowledge-library-sort';
const SEARCH_DEBOUNCE_MS = 300;

function readStoredSort(): KbLibrarySort {
    try {
        const stored = window.localStorage.getItem(SORT_STORAGE_KEY);
        return stored === 'title' ? 'title' : 'recent';
    } catch {
        return 'recent';
    }
}

/**
 * Knowledge library — the organization shelf, as the Library view of the
 * Memory page.
 *
 * Holds the shelf's state (folder selection, search, sort, class and Work
 * filters, the loaded pages and the bulk selection) and wires the folder
 * rail, the document list and the Archived view to the same-origin BFF.
 * Every document is a Knowledge Base document the per-Work workbench edits;
 * this view files, archives, restores and exports them without leaving the
 * page.
 *
 * Search is the list's own `q` filter (title, description, slug). The sort
 * choice persists per browser. Read state and pins are not part of this
 * view yet, so there are no unread badges or pinned group.
 */
export function LibraryPanel({ initial, works = [] }: LibraryPanelProps) {
    const t = useTranslations('dashboard.memoryPage.library');
    const workspace = useWorkspaceScope();
    const inOrganization = workspace?.kind === 'organization';

    const [tree, setTree] = useState<KbLibraryTreeDto | null>(initial?.tree ?? null);
    const [treeState, setTreeState] = useState<LoadState>(initial ? 'ready' : 'loading');

    const [selection, setSelection] = useState<LibrarySelection>({ kind: 'all' });
    const [query, setQuery] = useState('');
    const [appliedQuery, setAppliedQuery] = useState('');
    const [sort, setSort] = useState<KbLibrarySort>('recent');
    const [classFilter, setClassFilter] = useState<KbDocumentClass | ''>('');
    const [workFilter, setWorkFilter] = useState('');
    const [includeArchived, setIncludeArchived] = useState(false);

    const [documents, setDocuments] = useState<KbLibraryDocumentDto[]>(
        initial?.list.documents ?? [],
    );
    const [nextCursor, setNextCursor] = useState<string | null>(initial?.list.nextCursor ?? null);
    const [total, setTotal] = useState(initial?.list.total ?? 0);
    const [listState, setListState] = useState<LoadState>(
        initial ? (initial.loadFailed ? 'error' : 'ready') : 'loading',
    );
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const [pickerDocs, setPickerDocs] = useState<KbLibraryDocumentDto[] | null>(null);
    const [pickerError, setPickerError] = useState<string | null>(null);
    const [busyDocId, setBusyDocId] = useState<string | null>(null);
    const [createRequest, setCreateRequest] = useState(0);

    const inflight = useRef<AbortController | null>(null);
    // Folders created from the picker, so the confirmation can name one the
    // rail has not re-read yet.
    const createdFolders = useRef(new Map<string, string>());
    const skipFirstFetch = useRef(Boolean(initial) && !initial?.loadFailed);

    // Restore the persisted sort after mount (localStorage is unavailable
    // during SSR); the server render always starts on the default.
    useEffect(() => {
        const stored = readStoredSort();
        if (stored !== 'recent') {
            skipFirstFetch.current = false;
            setSort(stored);
        }
    }, []);

    useEffect(() => {
        const handle = setTimeout(() => setAppliedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [query]);

    const listQuery = useMemo<KbLibraryListQuery>(() => {
        const next: KbLibraryListQuery = { sort };
        if (selection.kind === 'archived') next.archived = 'only';
        else if (includeArchived && appliedQuery) next.archived = 'include';
        if (selection.kind === 'unfiled') next.folderId = 'unfiled';
        if (selection.kind === 'folder') next.folderId = selection.id;
        if (appliedQuery) next.q = appliedQuery;
        if (classFilter) next.classes = [classFilter];
        if (workFilter) next.workId = workFilter;
        return next;
    }, [selection, includeArchived, appliedQuery, sort, classFilter, workFilter]);

    const loadTree = useCallback(async () => {
        setTreeState((prev) => (prev === 'ready' ? prev : 'loading'));
        try {
            setTree(await knowledgeLibraryClient.tree());
            setTreeState('ready');
        } catch {
            setTreeState('error');
        }
    }, []);

    const loadFirstPage = useCallback(async (q: KbLibraryListQuery) => {
        inflight.current?.abort();
        const controller = new AbortController();
        inflight.current = controller;
        setListState('loading');
        try {
            const page = await knowledgeLibraryClient.list(q, controller.signal);
            if (inflight.current !== controller) return;
            setDocuments(page.documents);
            setNextCursor(page.nextCursor);
            setTotal(page.total);
            setListState('ready');
        } catch {
            if (controller.signal.aborted || inflight.current !== controller) return;
            setListState('error');
        }
    }, []);

    useEffect(() => {
        if (!initial || initial.loadFailed) void loadTree();
    }, [initial, loadTree]);

    useEffect(() => {
        if (skipFirstFetch.current) {
            skipFirstFetch.current = false;
            return;
        }
        void loadFirstPage(listQuery);
    }, [listQuery, loadFirstPage]);

    useEffect(() => () => inflight.current?.abort(), []);

    // A different shelf is a different selection — never carry ids across.
    useEffect(() => {
        setSelectedIds(new Set());
    }, [selection, appliedQuery, classFilter, workFilter]);

    const loadMore = useCallback(async () => {
        if (!nextCursor || isLoadingMore) return;
        setIsLoadingMore(true);
        try {
            const page = await knowledgeLibraryClient.list({ ...listQuery, cursor: nextCursor });
            setDocuments((prev) => {
                const seen = new Set(prev.map((doc) => doc.id));
                return [...prev, ...page.documents.filter((doc) => !seen.has(doc.id))];
            });
            setNextCursor(page.nextCursor);
            setTotal(page.total);
        } catch {
            toast.error(t('loadFailed'));
        } finally {
            setIsLoadingMore(false);
        }
    }, [nextCursor, isLoadingMore, listQuery, t]);

    const refresh = useCallback(async () => {
        await Promise.all([loadTree(), loadFirstPage(listQuery)]);
    }, [loadTree, loadFirstPage, listQuery]);

    const changeSort = (next: KbLibrarySort) => {
        setSort(next);
        try {
            window.localStorage.setItem(SORT_STORAGE_KEY, next);
        } catch {
            // Private mode or blocked storage — the choice lasts this visit.
        }
    };

    const folderName = useCallback(
        (folderPath: string | null) => formatFolderPath(folderPath) ?? t('unfiled'),
        [t],
    );

    // ─── Curation ────────────────────────────────────────────────────────

    const openPicker = (docs: KbLibraryDocumentDto[]) => {
        setPickerError(null);
        setPickerDocs(docs);
        if (!tree) void loadTree();
    };

    const fileErrorMessage = (error: unknown): string => {
        if (error instanceof LibraryRequestError) {
            if (error.code === 'FileBatchLimit') {
                return t('fileBatchLimit', {
                    max: KB_LIBRARY_FILE_BATCH_MAX,
                    count: pickerDocs?.length ?? 0,
                });
            }
            if (error.status === 403) return t('noEditAccessFile');
        }
        return t('fileFailed');
    };

    const fileInto = async (target: FolderPickerTarget) => {
        const docs = pickerDocs ?? [];
        if (docs.length === 0) return;
        setPickerError(null);
        try {
            await knowledgeLibraryClient.file(
                docs.map((doc) => doc.id),
                target,
            );
            const path =
                (target && createdFolders.current.get(target)) ??
                (tree ? findFolderPath(tree, target) : null);
            toast.success(
                target
                    ? t('filedToast', { count: docs.length, folder: folderName(path) })
                    : t('unfiledToast', { count: docs.length }),
            );
            setPickerDocs(null);
            setSelectedIds(new Set());
            await refresh();
        } catch (error) {
            setPickerError(fileErrorMessage(error));
            throw error;
        }
    };

    const createFolderForPicker = async (name: string): Promise<string> => {
        try {
            const folder = await knowledgeLibraryClient.createFolder(name, null);
            createdFolders.current.set(folder.id, folder.path);
            await loadTree();
            return folder.id;
        } catch (error) {
            setPickerError(t('folderFailed'));
            throw error;
        }
    };

    const archiveRef = useRef<
        ((doc: KbLibraryDocumentDto, opts?: { silent?: boolean }) => Promise<void>) | null
    >(null);

    const restore = useCallback(
        async (doc: KbLibraryDocumentDto) => {
            setBusyDocId(doc.id);
            try {
                const result = await knowledgeLibraryClient.unarchive(doc.id);
                const message = result.restoredToUnfiled
                    ? t('restoredToUnfiledToast', { title: doc.title })
                    : t('restoredToast', {
                          title: doc.title,
                          folder: folderName(result.document.folderPath),
                      });
                toast.success(message, {
                    action: {
                        label: t('undo'),
                        onClick: () => void archiveRef.current?.(doc, { silent: true }),
                    },
                });
                await refresh();
            } catch (error) {
                toast.error(
                    error instanceof LibraryRequestError && error.status === 403
                        ? t('noEditAccessRestore')
                        : t('restoreFailed'),
                );
            } finally {
                setBusyDocId(null);
            }
        },
        [folderName, refresh, t],
    );

    const archive = useCallback(
        async (doc: KbLibraryDocumentDto, opts: { silent?: boolean } = {}) => {
            setBusyDocId(doc.id);
            try {
                await knowledgeLibraryClient.archive(doc.id);
                if (!opts.silent) {
                    toast.success(t('archivedToast', { title: doc.title }), {
                        action: { label: t('undo'), onClick: () => void restore(doc) },
                    });
                }
                await refresh();
            } catch (error) {
                toast.error(
                    error instanceof LibraryRequestError && error.status === 403
                        ? t('noEditAccessArchive')
                        : t('archiveFailed'),
                );
            } finally {
                setBusyDocId(null);
            }
        },
        [refresh, restore, t],
    );
    archiveRef.current = archive;

    const exportDoc = useCallback(
        async (doc: KbLibraryDocumentDto) => {
            setBusyDocId(doc.id);
            try {
                await knowledgeLibraryClient.exportMarkdown(doc.id, `${doc.slug || 'document'}.md`);
            } catch {
                toast.error(t('exportFailed'));
            } finally {
                setBusyDocId(null);
            }
        },
        [t],
    );

    // ─── Shared folders ──────────────────────────────────────────────────

    const createFolder = async (name: string, parentId: string | null) => {
        await knowledgeLibraryClient.createFolder(name, parentId);
        await loadTree();
    };

    const renameFolder = async (folderId: string, name: string) => {
        await knowledgeLibraryClient.renameFolder(folderId, name);
        await refresh();
    };

    const deleteFolder = async (folderId: string) => {
        await knowledgeLibraryClient.deleteFolder(folderId);
        if (selection.kind === 'folder' && selection.id === folderId) {
            selectShelf({ kind: 'all' });
            await loadTree();
        } else {
            await refresh();
        }
    };

    /** Switch shelves; rows of the previous shelf never flash under the new one. */
    const selectShelf = useCallback((next: LibrarySelection) => {
        setSelection(next);
        setDocuments([]);
        setNextCursor(null);
    }, []);

    const toggleSelect = useCallback((docId: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(docId)) next.delete(docId);
            else next.add(docId);
            return next;
        });
    }, []);

    const clearSearch = () => {
        setQuery('');
        setAppliedQuery('');
        setIncludeArchived(false);
    };

    // ─── Render ──────────────────────────────────────────────────────────

    const hasFilters = Boolean(appliedQuery || classFilter || workFilter);
    const heading =
        selection.kind === 'folder'
            ? (findFolderName(tree, selection.id) ?? t('allDocuments'))
            : selection.kind === 'unfiled'
              ? t('unfiled')
              : t('allDocuments');

    let body: ReactNode;
    if (selection.kind === 'archived') {
        body = (
            <LibraryArchivedPanel
                documents={documents}
                total={tree?.archivedCount ?? total}
                state={listState}
                hasMore={Boolean(nextCursor)}
                isLoadingMore={isLoadingMore}
                onLoadMore={() => void loadMore()}
                onRetry={() => void loadFirstPage(listQuery)}
                onRestore={(doc) => void restore(doc)}
                onExport={(doc) => void exportDoc(doc)}
                busyDocId={busyDocId}
            />
        );
    } else if (listState === 'loading' && documents.length === 0) {
        body = (
            <div
                data-testid="library-list-loading"
                className="flex flex-col gap-2"
                aria-busy="true"
            >
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className="h-16 animate-pulse rounded-lg bg-surface-secondary dark:bg-white/5"
                    />
                ))}
            </div>
        );
    } else if (listState === 'error') {
        body = (
            <EmptyBox testId="library-load-failed" title={t('loadFailed')}>
                <button
                    type="button"
                    data-testid="library-retry"
                    onClick={() => void loadFirstPage(listQuery)}
                    className={secondaryButton}
                >
                    {t('tryAgain')}
                </button>
            </EmptyBox>
        );
    } else if (documents.length === 0) {
        if (appliedQuery) {
            body = (
                <EmptyBox
                    testId="library-no-results"
                    title={t('noResults', { query: appliedQuery })}
                >
                    <button type="button" onClick={clearSearch} className={secondaryButton}>
                        {t('clearSearch')}
                    </button>
                    {!includeArchived ? (
                        <button
                            type="button"
                            data-testid="library-search-archived"
                            onClick={() => setIncludeArchived(true)}
                            className={secondaryButton}
                        >
                            {t('searchArchived')}
                        </button>
                    ) : null}
                </EmptyBox>
            );
        } else if (hasFilters) {
            body = (
                <EmptyBox testId="library-no-filter-results" title={t('noFilterResults')}>
                    <button
                        type="button"
                        onClick={() => {
                            setClassFilter('');
                            setWorkFilter('');
                        }}
                        className={secondaryButton}
                    >
                        {t('clearFilters')}
                    </button>
                </EmptyBox>
            );
        } else if (selection.kind === 'folder') {
            body = (
                <EmptyBox
                    testId="library-empty-folder"
                    title={t('emptyFolderTitle')}
                    body={t('emptyFolderBody')}
                >
                    <button
                        type="button"
                        onClick={() => selectShelf({ kind: 'all' })}
                        className={secondaryButton}
                    >
                        {t('emptyFolderAction')}
                    </button>
                </EmptyBox>
            );
        } else {
            body = (
                <EmptyBox testId="library-empty" title={t('emptyTitle')} body={t('emptyBody')} icon>
                    <Link href={ROUTES.DASHBOARD_AGENTS} className={secondaryButton}>
                        {t('emptyAskAgent')}
                    </Link>
                    {tree?.canManageFolders ? (
                        <button
                            type="button"
                            data-testid="library-empty-new-folder"
                            onClick={() => setCreateRequest((n) => n + 1)}
                            className={secondaryButton}
                        >
                            {t('newFolder')}
                        </button>
                    ) : null}
                </EmptyBox>
            );
        }
    } else {
        body = (
            <LibraryDocumentList
                documents={documents}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onClearSelection={() => setSelectedIds(new Set())}
                onFileSelected={() =>
                    openPicker(documents.filter((doc) => selectedIds.has(doc.id)))
                }
                onFile={(doc) => openPicker([doc])}
                onArchive={(doc) => void archive(doc)}
                onExport={(doc) => void exportDoc(doc)}
                hasMore={Boolean(nextCursor)}
                isLoadingMore={isLoadingMore}
                onLoadMore={() => void loadMore()}
                busyDocId={busyDocId}
            />
        );
    }

    return (
        <section data-testid="library-panel" className="flex min-h-0 flex-col gap-4">
            {!inOrganization ? (
                <div
                    data-testid="library-no-organization"
                    className="flex items-start gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-sm text-text-muted dark:border-white/9 dark:bg-card-primary-dark dark:text-text-muted-dark"
                >
                    <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {t('noOrganization')}
                </div>
            ) : null}

            <div className="flex flex-col gap-4 lg:flex-row">
                <aside className="w-full shrink-0 lg:w-64">
                    <LibraryFolderRail
                        tree={tree}
                        state={treeState}
                        selection={selection}
                        onSelect={selectShelf}
                        onRetry={() => void loadTree()}
                        onCreateFolder={createFolder}
                        onRenameFolder={renameFolder}
                        onDeleteFolder={deleteFolder}
                        createRequest={createRequest}
                    />
                </aside>

                <div className="flex min-w-0 flex-1 flex-col gap-3">
                    {selection.kind !== 'archived' ? (
                        <>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h2 className="flex items-center gap-2 text-sm font-semibold text-text dark:text-text-dark">
                                    <Library
                                        className="h-4 w-4"
                                        strokeWidth={1.5}
                                        aria-hidden="true"
                                    />
                                    <span data-testid="library-heading">{heading}</span>
                                </h2>
                                <span
                                    data-testid="library-total"
                                    className="text-xs text-text-muted dark:text-text-muted-dark"
                                >
                                    {t('documentCount', { count: total })}
                                </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="relative min-w-[12rem] flex-1">
                                    <Search
                                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted dark:text-text-muted-dark"
                                        strokeWidth={1.5}
                                        aria-hidden="true"
                                    />
                                    <input
                                        data-testid="library-search"
                                        type="search"
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        placeholder={t('searchPlaceholder')}
                                        aria-label={t('searchPlaceholder')}
                                        maxLength={128}
                                        className={cn(
                                            'w-full rounded-lg border py-2 pl-9 pr-9 text-sm outline-none transition-colors',
                                            'border-card-border bg-card dark:border-white/9 dark:bg-card-primary-dark',
                                            'text-text placeholder-text-muted dark:text-text-dark dark:placeholder-text-muted-dark',
                                            'focus:border-primary dark:focus:border-white/20',
                                        )}
                                    />
                                    {query ? (
                                        <button
                                            type="button"
                                            onClick={clearSearch}
                                            aria-label={t('clearSearch')}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted dark:text-text-muted-dark"
                                        >
                                            <X className="h-4 w-4" aria-hidden="true" />
                                        </button>
                                    ) : listState === 'loading' ? (
                                        <Loader2
                                            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-text-muted dark:text-text-muted-dark"
                                            aria-hidden="true"
                                        />
                                    ) : null}
                                </div>
                                <label className="flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('sortLabel')}
                                    <select
                                        data-testid="library-sort"
                                        value={sort}
                                        onChange={(e) =>
                                            changeSort(e.target.value as KbLibrarySort)
                                        }
                                        className={selectClass}
                                    >
                                        <option value="recent">{t('sortRecent')}</option>
                                        <option value="title">{t('sortTitle')}</option>
                                    </select>
                                </label>
                                <select
                                    data-testid="library-filter-class"
                                    aria-label={t('filterClass')}
                                    value={classFilter}
                                    onChange={(e) =>
                                        setClassFilter(e.target.value as KbDocumentClass | '')
                                    }
                                    className={selectClass}
                                >
                                    <option value="">{t('filterClassAll')}</option>
                                    {KB_DOCUMENT_CLASSES.map((cls) => (
                                        <option key={cls} value={cls}>
                                            {cls}
                                        </option>
                                    ))}
                                </select>
                                {works.length > 0 ? (
                                    <select
                                        data-testid="library-filter-work"
                                        aria-label={t('filterWork')}
                                        value={workFilter}
                                        onChange={(e) => setWorkFilter(e.target.value)}
                                        className={selectClass}
                                    >
                                        <option value="">{t('filterWorkAll')}</option>
                                        {works.map((work) => (
                                            <option key={work.value} value={work.value}>
                                                {work.label}
                                            </option>
                                        ))}
                                    </select>
                                ) : null}
                            </div>
                        </>
                    ) : null}
                    {body}
                </div>
            </div>

            <FolderPickerDialog
                open={pickerDocs !== null}
                onOpenChange={(open) => {
                    if (!open) setPickerDocs(null);
                }}
                documentCount={pickerDocs?.length ?? 0}
                tree={tree}
                currentFolderId={pickerDocs?.length === 1 ? pickerDocs[0].folderId : undefined}
                onFile={fileInto}
                onCreateFolder={tree?.canManageFolders ? createFolderForPicker : undefined}
                error={pickerError}
            />
        </section>
    );
}

const secondaryButton =
    'inline-flex items-center rounded-lg border border-card-border bg-card px-3 py-1.5 text-sm text-text hover:border-border-secondary dark:border-white/9 dark:bg-card-primary-dark dark:text-text-dark';

const selectClass =
    'rounded-lg border border-card-border bg-card px-2 py-2 text-xs text-text dark:border-white/9 dark:bg-card-primary-dark dark:text-text-dark';

function EmptyBox({
    testId,
    title,
    body,
    icon,
    children,
}: {
    testId: string;
    title: string;
    body?: string;
    icon?: boolean;
    children?: ReactNode;
}) {
    return (
        <div
            data-testid={testId}
            className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center"
        >
            {icon ? (
                <span className="mb-2 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-surface-secondary dark:bg-card-primary-dark">
                    <Library
                        className="h-6 w-6 text-text-muted dark:text-text-muted-dark"
                        strokeWidth={1.5}
                        aria-hidden="true"
                    />
                </span>
            ) : null}
            <p className="text-sm font-medium text-text dark:text-text-dark">{title}</p>
            {body ? (
                <p className="max-w-md text-sm text-text-muted dark:text-text-muted-dark">{body}</p>
            ) : null}
            {children ? (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                    {children}
                </div>
            ) : null}
        </div>
    );
}

function findFolderName(tree: KbLibraryTreeDto | null, folderId: string): string | null {
    const stack = [...(tree?.folders ?? [])];
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.id === folderId) return node.name;
        stack.push(...node.children);
    }
    return null;
}

function findFolderPath(tree: KbLibraryTreeDto, folderId: string | null): string | null {
    if (!folderId) return null;
    const stack = [...tree.folders];
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.id === folderId) return node.path;
        stack.push(...node.children);
    }
    return null;
}
