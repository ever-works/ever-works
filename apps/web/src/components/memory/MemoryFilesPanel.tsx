'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    Bot,
    ChevronRight,
    Download,
    FolderClosed,
    FolderPlus,
    FileText,
    GitBranch,
    Loader2,
    Trash2,
    Upload,
    X,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type {
    MemoryFileRow,
    MemoryFilesListResponse,
    MemoryFolderNode,
    MemoryFolderSyncReport,
    MemoryFolderTreeResponse,
} from '@/lib/api/memory-files-types';

/**
 * Memory Files — the "Files" area of /memory.
 *
 * Browses EVERY file the caller can see (chat uploads + KB originals)
 * organized into user-defined folders: breadcrumb navigation, folder
 * rows first, New Folder / Upload actions, per-row move / download /
 * unlink, folder sync ("Sync now" when a git target is configured), an
 * agent-owner badge on agent-private folders, and a Global/Agents scope
 * toggle. Additive beside the existing memory panels; talks to the
 * same-origin BFF proxies under `/api/memory/files`.
 */

type ScopeFilter = 'all' | 'global' | 'agents';

function formatSize(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function MemoryFilesPanel() {
    const t = useTranslations('dashboard.memoryPage.files');

    const [folders, setFolders] = useState<MemoryFolderNode[]>([]);
    const [files, setFiles] = useState<MemoryFileRow[]>([]);
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
    const [scope, setScope] = useState<ScopeFilter>('all');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [isSubmittingFolder, setIsSubmittingFolder] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [syncingFolderId, setSyncingFolderId] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const refresh = useCallback(async (folderId: string | null) => {
        setIsLoading(true);
        try {
            const listUrl = folderId
                ? `/api/memory/files?folderId=${encodeURIComponent(folderId)}`
                : '/api/memory/files';
            const [treeRes, listRes] = await Promise.all([
                fetch('/api/memory/files/tree', { cache: 'no-store' }),
                fetch(listUrl, { cache: 'no-store' }),
            ]);
            if (treeRes.ok) {
                const body = (await treeRes.json()) as MemoryFolderTreeResponse;
                setFolders(body.folders ?? []);
            }
            if (listRes.ok) {
                const body = (await listRes.json()) as MemoryFilesListResponse;
                setFiles(body.files ?? []);
            }
        } catch {
            // Best-effort: keep the previous listing on a transient error.
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh(currentFolderId);
    }, [refresh, currentFolderId]);

    const currentFolder = useMemo(
        () => folders.find((f) => f.id === currentFolderId) ?? null,
        [folders, currentFolderId],
    );

    const breadcrumb = useMemo(() => {
        if (!currentFolder) return [] as MemoryFolderNode[];
        const byPath = new Map(folders.map((f) => [f.path, f]));
        const segments = currentFolder.path.split('/').filter(Boolean);
        const chain: MemoryFolderNode[] = [];
        let acc = '';
        for (const segment of segments) {
            acc += `/${segment}`;
            const node = byPath.get(acc);
            if (node) chain.push(node);
        }
        return chain;
    }, [currentFolder, folders]);

    const childFolders = useMemo(
        () =>
            folders
                .filter((f) => f.parentId === currentFolderId)
                .filter((f) =>
                    scope === 'all'
                        ? true
                        : scope === 'global'
                          ? !f.ownerAgentId
                          : Boolean(f.ownerAgentId),
                ),
        [folders, currentFolderId, scope],
    );

    const createFolder = useCallback(async () => {
        const name = newFolderName.trim();
        if (!name) return;
        setIsSubmittingFolder(true);
        setError(null);
        try {
            const res = await fetch('/api/memory/files/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    ...(currentFolderId ? { parentId: currentFolderId } : {}),
                }),
            });
            if (!res.ok) {
                setError(res.status === 409 ? t('folderExists') : t('folderCreateFailed'));
                return;
            }
            setNewFolderName('');
            setIsCreatingFolder(false);
            await refresh(currentFolderId);
        } catch {
            setError(t('folderCreateFailed'));
        } finally {
            setIsSubmittingFolder(false);
        }
    }, [newFolderName, currentFolderId, refresh, t]);

    const upload = useCallback(
        async (picked: File[]) => {
            if (picked.length === 0) return;
            setIsUploading(true);
            setError(null);
            try {
                for (const file of picked) {
                    const form = new FormData();
                    form.append('file', file);
                    if (currentFolderId) form.append('folderId', currentFolderId);
                    const res = await fetch('/api/memory/files/upload', {
                        method: 'POST',
                        body: form,
                    });
                    if (!res.ok) setError(t('uploadFailed'));
                }
                await refresh(currentFolderId);
            } catch {
                setError(t('uploadFailed'));
            } finally {
                setIsUploading(false);
            }
        },
        [currentFolderId, refresh, t],
    );

    const moveFile = useCallback(
        async (row: MemoryFileRow, folderId: string | null) => {
            setError(null);
            try {
                const res = await fetch('/api/memory/files/move', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        files: [{ source: row.source, id: row.id }],
                        folderId,
                    }),
                });
                if (!res.ok) {
                    setError(t('moveFailed'));
                    return;
                }
                await refresh(currentFolderId);
            } catch {
                setError(t('moveFailed'));
            }
        },
        [currentFolderId, refresh, t],
    );

    const deleteFolder = useCallback(
        async (folder: MemoryFolderNode) => {
            setError(null);
            try {
                const res = await fetch(
                    `/api/memory/files/folders/${encodeURIComponent(folder.id)}`,
                    { method: 'DELETE' },
                );
                if (res.status === 422) {
                    const confirmed = window.confirm(t('deleteRecursiveConfirm'));
                    if (!confirmed) return;
                    const forced = await fetch(
                        `/api/memory/files/folders/${encodeURIComponent(folder.id)}?recursive=true`,
                        { method: 'DELETE' },
                    );
                    if (!forced.ok) {
                        setError(t('deleteFailed'));
                        return;
                    }
                } else if (!res.ok) {
                    setError(t('deleteFailed'));
                    return;
                }
                if (currentFolderId === folder.id) setCurrentFolderId(folder.parentId);
                await refresh(currentFolderId === folder.id ? folder.parentId : currentFolderId);
            } catch {
                setError(t('deleteFailed'));
            }
        },
        [currentFolderId, refresh, t],
    );

    const syncFolder = useCallback(
        async (folder: MemoryFolderNode) => {
            setSyncingFolderId(folder.id);
            setError(null);
            setNotice(null);
            try {
                const res = await fetch(
                    `/api/memory/files/folders/${encodeURIComponent(folder.id)}/sync`,
                    { method: 'POST' },
                );
                if (!res.ok) {
                    setError(res.status === 422 ? t('syncNotConfigured') : t('syncFailed'));
                    return;
                }
                const report = (await res.json()) as MemoryFolderSyncReport;
                const committed = report.results.filter((r) => r.status === 'committed').length;
                const skipped = report.results.filter(
                    (r) => r.status === 'skipped-too-large',
                ).length;
                setNotice(t('syncDone', { committed, skipped }));
            } catch {
                setError(t('syncFailed'));
            } finally {
                setSyncingFolderId(null);
            }
        },
        [t],
    );

    const provenanceLabel = (row: MemoryFileRow): string => {
        if (row.provenance.taskId) return t('provenanceTask');
        if (row.provenance.missionId) return t('provenanceMission');
        if (row.provenance.ideaId) return t('provenanceIdea');
        if (row.provenance.agentId) return t('provenanceAgent');
        if (row.provenance.workId) return t('provenanceWork');
        return t('provenanceChat');
    };

    return (
        <div
            data-testid="memory-files-panel"
            className="flex flex-col gap-3 rounded-lg border border-card-border dark:border-white/9 bg-card dark:bg-card-primary-dark p-4"
        >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                    <FolderClosed
                        className="w-4 h-4 text-text-muted dark:text-text-muted-dark shrink-0"
                        strokeWidth={1.5}
                    />
                    <span className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </span>
                    {isLoading && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-text-muted dark:text-text-muted-dark" />
                    )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    {/* Scope toggle */}
                    <div className="inline-flex rounded-lg border border-card-border dark:border-white/9 overflow-hidden text-xs">
                        {(['all', 'global', 'agents'] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                data-testid={`memory-files-scope-${value}`}
                                onClick={() => setScope(value)}
                                aria-pressed={scope === value}
                                className={cn(
                                    'px-2.5 py-1.5 transition-colors',
                                    scope === value
                                        ? 'bg-primary/10 text-primary dark:text-white'
                                        : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                                )}
                            >
                                {value === 'all'
                                    ? t('scopeAll')
                                    : value === 'global'
                                      ? t('scopeGlobal')
                                      : t('scopeAgents')}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        data-testid="memory-files-new-folder"
                        onClick={() => setIsCreatingFolder((v) => !v)}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                            'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                            'text-text dark:text-text-dark hover:border-border-secondary dark:hover:border-white/20',
                        )}
                    >
                        <FolderPlus className="w-4 h-4" strokeWidth={1.5} />
                        {t('newFolder')}
                    </button>
                    <input
                        ref={inputRef}
                        type="file"
                        multiple
                        hidden
                        data-testid="memory-files-upload-input"
                        onChange={(e) => {
                            const picked = Array.from(e.target.files ?? []);
                            if (picked.length > 0) void upload(picked);
                            e.target.value = '';
                        }}
                    />
                    <button
                        type="button"
                        data-testid="memory-files-upload"
                        onClick={() => inputRef.current?.click()}
                        disabled={isUploading}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                            'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                            'text-text dark:text-text-dark hover:border-border-secondary dark:hover:border-white/20',
                            'disabled:opacity-60 disabled:cursor-not-allowed',
                        )}
                    >
                        {isUploading ? (
                            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                        ) : (
                            <Upload className="w-4 h-4" strokeWidth={1.5} />
                        )}
                        {t('upload')}
                    </button>
                </div>
            </div>
            <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('subtitle')}</p>

            {/* Notices */}
            {error && (
                <div
                    data-testid="memory-files-error"
                    className="flex items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400"
                >
                    <span>{error}</span>
                    <button type="button" onClick={() => setError(null)} aria-label={t('dismiss')}>
                        <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </button>
                </div>
            )}
            {notice && (
                <div
                    data-testid="memory-files-notice"
                    className="flex items-start justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-text dark:text-text-dark"
                >
                    <span>{notice}</span>
                    <button type="button" onClick={() => setNotice(null)} aria-label={t('dismiss')}>
                        <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </button>
                </div>
            )}

            {/* New folder inline form */}
            {isCreatingFolder && (
                <form
                    data-testid="memory-files-new-folder-form"
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void createFolder();
                    }}
                >
                    <input
                        autoFocus
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        placeholder={t('folderNamePlaceholder')}
                        maxLength={120}
                        className={cn(
                            'flex-1 text-sm rounded-lg px-3 py-2 outline-none transition-colors',
                            'bg-card dark:bg-card-primary-dark border border-card-border dark:border-white/9',
                            'text-text dark:text-text-dark placeholder-text-muted dark:placeholder-text-muted-dark',
                            'focus:border-primary dark:focus:border-white/20',
                        )}
                    />
                    <button
                        type="submit"
                        disabled={isSubmittingFolder || newFolderName.trim().length === 0}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                            'bg-primary text-white hover:bg-primary/90 dark:bg-white dark:text-gray-900 dark:hover:bg-white/90',
                            'disabled:opacity-60 disabled:cursor-not-allowed',
                        )}
                    >
                        {isSubmittingFolder && (
                            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                        )}
                        {t('create')}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setIsCreatingFolder(false);
                            setNewFolderName('');
                        }}
                        className="text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                    >
                        {t('cancel')}
                    </button>
                </form>
            )}

            {/* Breadcrumb */}
            <nav
                data-testid="memory-files-breadcrumb"
                className="flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark flex-wrap"
            >
                <button
                    type="button"
                    onClick={() => setCurrentFolderId(null)}
                    className={cn(
                        'hover:text-text dark:hover:text-text-dark transition-colors',
                        currentFolderId === null && 'font-medium text-text dark:text-text-dark',
                    )}
                >
                    {t('root')}
                </button>
                {breadcrumb.map((node) => (
                    <span key={node.id} className="inline-flex items-center gap-1">
                        <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
                        <button
                            type="button"
                            onClick={() => setCurrentFolderId(node.id)}
                            className={cn(
                                'hover:text-text dark:hover:text-text-dark transition-colors',
                                node.id === currentFolderId &&
                                    'font-medium text-text dark:text-text-dark',
                            )}
                        >
                            {node.name}
                        </button>
                    </span>
                ))}
            </nav>

            {/* Table */}
            {childFolders.length === 0 && files.length === 0 ? (
                <p
                    data-testid="memory-files-empty"
                    className="text-xs text-text-muted dark:text-text-muted-dark py-6 text-center"
                >
                    {t('empty')}
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark">
                                <th className="py-1.5 pr-3 font-medium">{t('columnName')}</th>
                                <th className="py-1.5 pr-3 font-medium w-24">{t('columnSize')}</th>
                                <th className="py-1.5 pr-3 font-medium w-32">
                                    {t('columnModified')}
                                </th>
                                <th className="py-1.5 w-40" aria-label={t('columnActions')} />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-card-border dark:divide-white/9">
                            {childFolders.map((folder) => (
                                <tr
                                    key={folder.id}
                                    data-testid={`memory-files-folder-${folder.id}`}
                                >
                                    <td className="py-2 pr-3">
                                        <button
                                            type="button"
                                            onClick={() => setCurrentFolderId(folder.id)}
                                            className="inline-flex items-center gap-2 text-text dark:text-text-dark hover:underline min-w-0"
                                        >
                                            <FolderClosed
                                                className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                                strokeWidth={1.5}
                                            />
                                            <span className="truncate">{folder.name}</span>
                                            {folder.ownerAgentId && (
                                                <span
                                                    data-testid={`memory-files-agent-badge-${folder.id}`}
                                                    title={folder.ownerAgentId}
                                                    className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary dark:text-white"
                                                >
                                                    <Bot
                                                        className="w-2.5 h-2.5"
                                                        strokeWidth={1.5}
                                                    />
                                                    {t('agentBadge')}
                                                </span>
                                            )}
                                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                                {t('fileCount', { count: folder.fileCount })}
                                            </span>
                                        </button>
                                    </td>
                                    <td className="py-2 pr-3 text-text-muted dark:text-text-muted-dark">
                                        —
                                    </td>
                                    <td className="py-2 pr-3 text-text-muted dark:text-text-muted-dark">
                                        {formatDate(folder.updatedAt)}
                                    </td>
                                    <td className="py-2">
                                        <div className="flex items-center justify-end gap-1.5">
                                            {folder.syncRepo && (
                                                <button
                                                    type="button"
                                                    data-testid={`memory-files-sync-${folder.id}`}
                                                    title={t('syncNow')}
                                                    onClick={() => void syncFolder(folder)}
                                                    disabled={syncingFolderId === folder.id}
                                                    className="p-1 rounded text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors disabled:opacity-60"
                                                >
                                                    {syncingFolderId === folder.id ? (
                                                        <Loader2
                                                            className="w-4 h-4 animate-spin"
                                                            strokeWidth={1.5}
                                                        />
                                                    ) : (
                                                        <GitBranch
                                                            className="w-4 h-4"
                                                            strokeWidth={1.5}
                                                        />
                                                    )}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                data-testid={`memory-files-delete-${folder.id}`}
                                                title={t('deleteFolder')}
                                                onClick={() => void deleteFolder(folder)}
                                                className="p-1 rounded text-text-muted dark:text-text-muted-dark hover:text-red-500 transition-colors"
                                            >
                                                <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {files.map((row) => (
                                <tr
                                    key={`${row.source}:${row.id}`}
                                    data-testid={`memory-files-row-${row.id}`}
                                >
                                    <td className="py-2 pr-3">
                                        <span className="inline-flex items-center gap-2 min-w-0 text-text dark:text-text-dark">
                                            <FileText
                                                className="w-4 h-4 shrink-0 text-text-muted dark:text-text-muted-dark"
                                                strokeWidth={1.5}
                                            />
                                            <span className="truncate" title={row.filename}>
                                                {row.filename}
                                            </span>
                                            <span className="inline-flex items-center rounded border border-card-border dark:border-white/9 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                                {provenanceLabel(row)}
                                            </span>
                                        </span>
                                    </td>
                                    <td className="py-2 pr-3 text-text-muted dark:text-text-muted-dark">
                                        {formatSize(row.size)}
                                    </td>
                                    <td className="py-2 pr-3 text-text-muted dark:text-text-muted-dark">
                                        {formatDate(row.updatedAt)}
                                    </td>
                                    <td className="py-2">
                                        <div className="flex items-center justify-end gap-1.5">
                                            <select
                                                aria-label={t('moveTo')}
                                                data-testid={`memory-files-move-${row.id}`}
                                                value={row.folderId ?? ''}
                                                onChange={(e) =>
                                                    void moveFile(row, e.target.value || null)
                                                }
                                                className={cn(
                                                    'text-xs rounded border px-1.5 py-1 max-w-32',
                                                    'bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9',
                                                    'text-text-muted dark:text-text-muted-dark',
                                                )}
                                            >
                                                <option value="">{t('rootOption')}</option>
                                                {folders.map((f) => (
                                                    <option key={f.id} value={f.id}>
                                                        {f.path}
                                                    </option>
                                                ))}
                                            </select>
                                            <a
                                                href={`/api/memory/files/${encodeURIComponent(row.id)}/download?source=${row.source}`}
                                                data-testid={`memory-files-download-${row.id}`}
                                                title={t('download')}
                                                className="p-1 rounded text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                                            >
                                                <Download className="w-4 h-4" strokeWidth={1.5} />
                                            </a>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
