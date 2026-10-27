'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
    ArrowLeftRight,
    Download,
    EyeOff,
    FolderUp,
    Lock,
    MonitorSmartphone,
    OctagonX,
    RotateCw,
    ShieldOff,
    Trash2,
    Upload,
    WifiOff,
} from 'lucide-react';
import {
    FLEET_FILES_LIST_REFRESH_MS,
    normalizeFleetFileRelativePath,
    type FleetFileConflictView,
    type FleetFileEntryView,
    type FleetFileListView,
    type FleetFileRootsResponse,
    type FleetFileRootView,
    type FleetFilesDownloadCheck,
    type FleetFilesOperationView,
    type FleetFilesTransfersResponse,
    type FleetFilesWritePolicy,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { applyBrowserWorkspaceScope, browserApiFetch } from '@/lib/api/browser-api';
import { parseWorkspacePath, withWorkspaceScopeQuery } from '@/lib/workspace-scope';
import { relativeTime } from '../fleet-hub.shared';
import { FLEET_FILES_DOCS_URL } from '../fleet-links';
import { CopyCommand } from '../link/CopyCommand';
import type { FleetComputerTabProps } from '../registry';
import { readSessionError } from '../sessions/sessions.shared';
import { FilesCopyDialog, type FilesCopyTarget } from './FilesCopyDialog';
import { FilesConflictDialog, FilesCredentialDialog, FilesDeleteDialog } from './FilesDialogs';
import { FilesGrid } from './FilesGrid';
import { FilesOperationsStrip, type LocalUpload } from './FilesOperationsStrip';
import {
    FILES_HIDDEN_STORAGE_KEY,
    breadcrumbSegments,
    buildUploadStream,
    deleteConfirmName,
    filesApiPath,
    filesTabCard,
    formatFileBytes,
    isUploadRefusal,
    parentFilePath,
    rootsSummary,
    selectionTooLarge,
    sortFileEntries,
    type FilesError,
    type FilesTabCard,
    type UploadPick,
} from './files.shared';

/**
 * Files on computers (FL-11, spec §0, §5, T-11…T-13) — the computer page's
 * Files tab: a root picker limited to the computer's allowed roots (its
 * checkouts, the workspace root, `--files-root` folders), the breadcrumb, the
 * hidden toggle (remembered per viewer), the folder as a keyboard grid, and
 * the actions — Download (one file as itself, a selection as a .zip),
 * Upload files or a folder (or drop files on the list; same-name entries are
 * listed first, Skip by default), Delete (type the name). Transfers stream
 * through the computer's link; the Operations strip shows them with Cancel;
 * the footer says which roots are visible and that transfers spend no
 * credits. When the computer cannot be browsed, ONE card says why (§5.7).
 */
export default function FilesTab({ node }: FleetComputerTabProps) {
    const t = useTranslations('fleet.files');
    const locale = useLocale();
    const search = useSearchParams();
    const [roots, setRoots] = useState<FleetFileRootsResponse | null>(null);
    const [error, setError] = useState<FilesError | null>(null);
    const [rootId, setRootId] = useState<string | null>(search?.get('root') ?? null);
    const [path, setPath] = useState<string>(
        () => normalizeFleetFileRelativePath(search?.get('path') ?? '') ?? '',
    );
    const [hidden, setHidden] = useState(false);
    const [list, setList] = useState<FleetFileListView | null>(null);
    const [listError, setListError] = useState<FilesError | null>(null);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [announcement, setAnnouncement] = useState('');
    const [transfers, setTransfers] = useState<FleetFilesTransfersResponse | null>(null);
    const [uploads, setUploads] = useState<LocalUpload[]>([]);
    const [checking, setChecking] = useState(false);
    const [credential, setCredential] = useState<{
        names: string[];
        count: number;
        entries: string[];
        /** P2: a credential-shaped file inside a copy asks the same way. */
        copy?: { target: FilesCopyTarget; policy: FleetFilesWritePolicy };
    } | null>(null);
    const [conflicts, setConflicts] = useState<{
        items: FleetFileConflictView[];
        picks: UploadPick[];
        total: number;
        /** P2: conflicts at a copy's destination (the picks are then empty). */
        copy?: { target: FilesCopyTarget; names: string[] };
    } | null>(null);
    const [copying, setCopying] = useState<string[] | null>(null);
    const [deleting, setDeleting] = useState<{ names: string[]; expected: string } | null>(null);
    const [deletePending, setDeletePending] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const filesInput = useRef<HTMLInputElement | null>(null);
    const folderInput = useRef<HTMLInputElement | null>(null);
    const unavailable = node.kind === 'desktop-node' || node.status === 'offline';

    // FR-7: the hidden toggle persists per viewer.
    useEffect(() => {
        try {
            setHidden(window.localStorage.getItem(FILES_HIDDEN_STORAGE_KEY) === '1');
        } catch {
            // storage blocked: the default (off) stands
        }
    }, []);
    const toggleHidden = () => {
        setHidden((current) => {
            const next = !current;
            try {
                window.localStorage.setItem(FILES_HIDDEN_STORAGE_KEY, next ? '1' : '0');
            } catch {
                // storage blocked: the toggle still works for this visit
            }
            return next;
        });
    };

    const loadRoots = useCallback(async () => {
        if (unavailable) return;
        try {
            const response = await browserApiFetch(filesApiPath(node.id, 'roots'), {
                method: 'GET',
                cache: 'no-store',
            });
            const body = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                setError(readSessionError(response.status, body));
                return;
            }
            const value = body as FleetFileRootsResponse;
            setError(null);
            setRoots(value);
            setRootId((current) =>
                current && value.roots.some((root) => root.id === current)
                    ? current
                    : (value.roots[0]?.id ?? null),
            );
        } catch {
            setError({ code: 'network', hint: null, details: {}, status: 0 });
        }
    }, [node.id, unavailable]);

    const root: FleetFileRootView | null = useMemo(
        () => roots?.roots.find((candidate) => candidate.id === rootId) ?? null,
        [roots, rootId],
    );

    const loadList = useCallback(async () => {
        if (!root) return;
        setLoading(true);
        try {
            const response = await browserApiFetch(
                filesApiPath(node.id, 'list', {
                    root: root.id,
                    path,
                    hidden: hidden ? 'true' : undefined,
                }),
                { method: 'GET', cache: 'no-store' },
            );
            const body = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                setListError(readSessionError(response.status, body));
                return;
            }
            setListError(null);
            setList(body as FleetFileListView);
        } catch {
            setListError({ code: 'network', hint: null, details: {}, status: 0 });
        } finally {
            setLoading(false);
        }
    }, [node.id, root, path, hidden]);

    const loadTransfers = useCallback(async () => {
        if (unavailable) return;
        try {
            const response = await browserApiFetch(filesApiPath(node.id, 'transfers'), {
                method: 'GET',
                cache: 'no-store',
            });
            if (response.ok) setTransfers((await response.json()) as FleetFilesTransfersResponse);
        } catch {
            // the strip keeps what it had
        }
    }, [node.id, unavailable]);

    useEffect(() => {
        void loadRoots();
    }, [loadRoots]);

    useEffect(() => {
        setSelected(new Set());
        void loadList();
        const timer = setInterval(() => {
            if (typeof document === 'undefined' || document.visibilityState === 'visible')
                void loadList();
        }, FLEET_FILES_LIST_REFRESH_MS);
        return () => clearInterval(timer);
    }, [loadList]);

    const running =
        uploads.some((upload) => upload.state === 'running') ||
        (transfers?.transfers.some((view) => view.state === 'running') ?? false);
    useEffect(() => {
        void loadTransfers();
        const timer = setInterval(() => void loadTransfers(), running ? 2_000 : 10_000);
        return () => clearInterval(timer);
    }, [loadTransfers, running]);

    const entries = useMemo(() => sortFileEntries(list?.entries ?? []), [list]);
    const selection = entries.filter((entry) => selected.has(entry.name));
    const selectionBytes = selection.reduce(
        (sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0),
        0,
    );
    const folderLabel = path
        ? `${root?.label ?? ''} / ${path.split('/').join(' / ')}`
        : (root?.label ?? '');
    const card: FilesTabCard | null = filesTabCard(node, error, roots ? roots.roots : null);
    const permissionDenied = card?.kind === 'permission-denied';

    // ─── Actions ─────────────────────────────────────────────────────────

    const open = (entry: FleetFileEntryView) => {
        setPath((current) => (current ? `${current}/${entry.name}` : entry.name));
        setAnnouncement(t('loading', { folder: entry.name }));
    };
    const up = () => setPath((current) => parentFilePath(current));
    const toggle = (name: string) =>
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    const toggleAll = () =>
        setSelected((current) =>
            entries.length > 0 && entries.every((entry) => current.has(entry.name))
                ? new Set()
                : new Set(entries.map((entry) => entry.name)),
        );

    /** The browser downloads it itself (a hidden frame, so the page stays put). */
    const startDownload = (names: string[], confirm: boolean) => {
        if (!root) return;
        const href = withWorkspaceScopeQuery(
            filesApiPath(node.id, 'download', {
                root: root.id,
                path,
                entries: names,
                confirm: confirm ? 'true' : undefined,
            }),
            parseWorkspacePath(window.location.pathname),
        );
        const frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.src = href;
        document.body.appendChild(frame);
        window.setTimeout(() => frame.remove(), 60_000);
        setAnnouncement(t('operations.starting'));
        window.setTimeout(() => void loadTransfers(), 1_000);
    };

    const download = async () => {
        if (!root || selection.length === 0) return;
        const names = selection.map((entry) => entry.name);
        setChecking(true);
        try {
            const response = await browserApiFetch(filesApiPath(node.id, 'download/check'), {
                method: 'POST',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root: root.id, path, entries: names }),
            });
            const body = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                const read = readSessionError(response.status, body);
                setAnnouncement(read.hint ?? t('errors.generic', { hint: read.code }));
                return;
            }
            const check = body as FleetFilesDownloadCheck;
            if (check.credentialShapedCount > 0) {
                setCredential({
                    names: check.credentialShaped,
                    count: check.credentialShapedCount,
                    entries: names,
                });
                return;
            }
            startDownload(names, false);
        } catch {
            setAnnouncement(t('states.unreachable', { node: node.name }));
        } finally {
            setChecking(false);
        }
    };

    const sendUpload = (picks: UploadPick[], policy: FleetFilesWritePolicy) => {
        if (!root) return;
        const stream = buildUploadStream(picks);
        if (isUploadRefusal(stream)) return;
        const label = picks.length === 1 ? picks[0].path : `${picks.length} items`;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // eslint-disable-next-line no-restricted-syntax -- XHR for upload progress; the selector is set below via applyBrowserWorkspaceScope + setRequestHeader (EW-788)
        const xhr = new XMLHttpRequest();
        const patch = (change: Partial<LocalUpload>) =>
            setUploads((current) =>
                current.map((upload) => (upload.id === id ? { ...upload, ...change } : upload)),
            );
        const upload: LocalUpload = {
            id,
            label,
            loaded: 0,
            total: stream.blob.size,
            startedAt: Date.now(),
            state: 'running',
            cancel: () => {
                xhr.abort();
                patch({
                    state: 'cancelled',
                    message: t('operations.cancelled', { moved: '…', node: node.name }),
                });
            },
        };
        setUploads((current) => [upload, ...current].slice(0, 10));
        xhr.open(
            'POST',
            filesApiPath(node.id, 'upload', {
                root: root.id,
                path,
                replaceAll: policy.replaceAll ? 'true' : undefined,
                replace: policy.replace,
                entries: stream.entries,
                bytes: stream.bytes,
                label: label.slice(0, 200),
            }),
        );
        applyBrowserWorkspaceScope({ 'Content-Type': 'application/octet-stream' }).forEach(
            (value, name) => xhr.setRequestHeader(name, value),
        );
        xhr.upload.onprogress = (event) =>
            patch({ loaded: event.loaded, total: event.total || stream.blob.size });
        xhr.onload = () => {
            let body: unknown = null;
            try {
                body = JSON.parse(xhr.responseText);
            } catch {
                // a non-JSON answer reads as the status alone
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                const result = body as {
                    entries?: number;
                    replaced?: number;
                    skipped?: number;
                } | null;
                const message = t('operations.uploaded', {
                    count: result?.entries ?? stream.entries,
                    replaced: result?.replaced ?? 0,
                    skipped: result?.skipped ?? 0,
                });
                patch({ state: 'done', loaded: stream.blob.size, message });
                setAnnouncement(message);
                void loadList();
            } else {
                const read = readSessionError(xhr.status, body);
                const message = t('operations.failed', { hint: read.hint ?? read.code });
                patch({ state: 'failed', message });
                setAnnouncement(message);
            }
            void loadTransfers();
        };
        xhr.onerror = () => {
            const message = t('operations.interrupted', {
                node: node.name,
                moved: formatFileBytes(upload.loaded),
            });
            patch({ state: 'failed', message });
            setAnnouncement(message);
        };
        xhr.send(stream.blob);
    };

    const upload = async (picks: UploadPick[]) => {
        if (!root || picks.length === 0) return;
        const stream = buildUploadStream(picks);
        if (isUploadRefusal(stream)) {
            setAnnouncement(
                stream.reason === 'entries'
                    ? t('errors.entries')
                    : stream.reason === 'bytes'
                      ? t('errors.bytes')
                      : t('errors.name', { name: stream.name ?? '' }),
            );
            return;
        }
        try {
            const response = await browserApiFetch(filesApiPath(node.id, 'conflicts'), {
                method: 'POST',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root: root.id, path, names: stream.tops }),
            });
            const body = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                const read = readSessionError(response.status, body);
                setAnnouncement(read.hint ?? t('errors.generic', { hint: read.code }));
                return;
            }
            const found = (body as FleetFileConflictView[]) ?? [];
            if (found.length > 0) {
                setConflicts({ items: found, picks, total: stream.tops.length });
                return;
            }
            sendUpload(picks, {});
        } catch {
            setAnnouncement(t('states.unreachable', { node: node.name }));
        }
    };

    const picksFrom = (files: FileList | null, folder: boolean): UploadPick[] =>
        Array.from(files ?? []).map((file) => ({
            file,
            path: folder && file.webkitRelativePath ? file.webkitRelativePath : file.name,
        }));

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (!root || permissionDenied) return;
        // Files only (a dropped folder shows as an empty entry — use "Upload a folder"); spec §8.
        const picks = Array.from(event.dataTransfer.files)
            .filter((file) => file.size > 0 || file.type !== '')
            .map((file) => ({ file, path: file.name }));
        void upload(picks);
    };

    const startDelete = () => {
        if (!root || selection.length === 0) return;
        const names = selection.map((entry) => entry.name);
        setDeleteError(null);
        setDeleting({ names, expected: deleteConfirmName(names, path, root) });
    };

    const confirmDelete = async (typed: string) => {
        if (!root || !deleting) return;
        setDeletePending(true);
        setDeleteError(null);
        try {
            const response = await browserApiFetch(filesApiPath(node.id, 'delete'), {
                method: 'POST',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    root: root.id,
                    path,
                    entries: deleting.names,
                    confirmName: typed,
                }),
            });
            const body = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                const read = readSessionError(response.status, body);
                setDeleteError(read.hint ?? read.code);
                return;
            }
            const removed = (body as { removed?: number } | null)?.removed ?? deleting.names.length;
            setAnnouncement(t('delete.done', { count: removed }));
            setDeleting(null);
            setSelected(new Set());
            void loadList();
        } catch {
            setDeleteError(t('states.unreachable', { node: node.name }));
        } finally {
            setDeletePending(false);
        }
    };

    // ─── Copy between computers (P2, FR-24…FR-29) ────────────────────────

    /** The copy itself (202): the Operations strip of both computers follows it. */
    const sendCopy = async (
        names: string[],
        target: FilesCopyTarget,
        policy: FleetFilesWritePolicy,
        confirm: boolean,
    ) => {
        if (!root) return;
        try {
            const response = await browserApiFetch(filesApiPath(node.id, 'copy'), {
                method: 'POST',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    root: root.id,
                    path,
                    entries: names,
                    to: { nodeId: target.nodeId, root: target.root, path: target.path },
                    ...(policy.replaceAll ? { replaceAll: true } : {}),
                    ...(policy.replace ? { replace: policy.replace } : {}),
                    ...(confirm ? { confirm: true } : {}),
                }),
            });
            const body = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                const read = readSessionError(response.status, body);
                if (read.code === 'confirmation_required' && !confirm) {
                    const named = Array.isArray(read.details.credentialShaped)
                        ? (read.details.credentialShaped as string[])
                        : [];
                    const count =
                        typeof read.details.count === 'number' ? read.details.count : named.length;
                    setCredential({
                        names: named,
                        count,
                        entries: names,
                        copy: { target, policy },
                    });
                    return;
                }
                setAnnouncement(t('operations.failed', { hint: read.hint ?? read.code }));
                return;
            }
            setAnnouncement(t('copy.started', { count: names.length, node: target.nodeName }));
            void loadTransfers();
        } catch {
            setAnnouncement(t('states.unreachable', { node: node.name }));
        }
    };

    /** Same-name entries at the destination are listed first (FR-26); nothing moves until the person chooses. */
    const startCopy = async (names: string[], target: FilesCopyTarget) => {
        try {
            const response = await browserApiFetch(filesApiPath(target.nodeId, 'conflicts'), {
                method: 'POST',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root: target.root, path: target.path, names }),
            });
            const body = (await response.json().catch(() => null)) as unknown;
            if (!response.ok) {
                const read = readSessionError(response.status, body);
                setAnnouncement(read.hint ?? t('errors.generic', { hint: read.code }));
                return;
            }
            const found = (body as FleetFileConflictView[]) ?? [];
            if (found.length > 0) {
                setConflicts({
                    items: found,
                    picks: [],
                    total: names.length,
                    copy: { target, names },
                });
                return;
            }
            await sendCopy(names, target, {}, false);
        } catch {
            setAnnouncement(t('states.unreachable', { node: target.nodeName }));
        }
    };

    const cancelTransfer = async (view: FleetFilesOperationView) => {
        const query = view.operationId
            ? `?operationId=${encodeURIComponent(view.operationId)}`
            : '';
        await browserApiFetch(
            `${filesApiPath(node.id, `transfers/${encodeURIComponent(view.id)}`)}${query}`,
            {
                method: 'DELETE',
                cache: 'no-store',
            },
        ).catch(() => null);
        void loadTransfers();
    };

    // ─── Render ──────────────────────────────────────────────────────────

    if (card && !permissionDenied) {
        return (
            <FilesStateCard
                card={card}
                nodeName={node.name}
                locale={locale}
                onRetry={() => void loadRoots()}
            />
        );
    }

    const summary = roots ? rootsSummary(roots.roots) : null;
    const rootsList = summary
        ? [
              ...(summary.checkouts > 0
                  ? [t('footer.checkouts', { count: summary.checkouts })]
                  : []),
              ...(summary.workspace ? [t('footer.workspace')] : []),
              ...summary.listed,
          ].join(', ')
        : '';
    const current = transfers?.transfers.find((view) => view.state === 'running') ?? null;
    const today = formatFileBytes(transfers?.todayBytes ?? 0);
    const tooMany = selectionTooLarge(selection.length);

    return (
        <div className="space-y-3" data-testid="fleet-files-tab">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="inline-flex items-center gap-2">
                    <span className="text-text-muted dark:text-text-muted-dark">
                        {t('roots.label')}
                    </span>
                    <select
                        value={rootId ?? ''}
                        disabled={!roots || permissionDenied}
                        onChange={(event) => {
                            setRootId(event.target.value);
                            setPath('');
                        }}
                        className="rounded-md border border-border dark:border-border-dark bg-transparent px-2 py-1"
                        data-testid="fleet-files-root"
                    >
                        {(roots?.roots ?? []).map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                                {candidate.kind === 'checkout'
                                    ? t('roots.checkout', { name: candidate.label })
                                    : candidate.kind === 'workspace'
                                      ? t('roots.workspace')
                                      : candidate.label}
                            </option>
                        ))}
                    </select>
                </label>
                <nav
                    aria-label={t('breadcrumb.label')}
                    className="flex flex-wrap items-center gap-1 min-w-0"
                >
                    <button
                        type="button"
                        className="text-text dark:text-text-dark hover:underline"
                        onClick={() => setPath('')}
                        aria-label={t('breadcrumb.top', { root: root?.label ?? '' })}
                    >
                        /
                    </button>
                    {breadcrumbSegments(path).map((segment) => (
                        <span key={segment.path} className="inline-flex items-center gap-1">
                            <button
                                type="button"
                                className="text-text dark:text-text-dark hover:underline"
                                onClick={() => setPath(segment.path)}
                            >
                                {segment.name}
                            </button>
                            <span className="text-text-muted dark:text-text-muted-dark">/</span>
                        </span>
                    ))}
                </nav>
                <span className="flex-1" />
                <label className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark">
                    <input
                        type="checkbox"
                        checked={hidden}
                        onChange={toggleHidden}
                        data-testid="fleet-files-hidden"
                    />
                    <EyeOff className="w-3 h-3" aria-hidden="true" />
                    {t('hidden')}
                </label>
                <button
                    type="button"
                    onClick={() => void loadList()}
                    className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                    aria-label={t('refresh')}
                >
                    <RotateCw className="w-3 h-3" aria-hidden="true" />
                </button>
            </div>

            {permissionDenied ? (
                <p
                    className="text-sm text-text dark:text-text-dark flex items-start gap-2 rounded-xl border border-border dark:border-border-dark p-4"
                    role="status"
                    data-testid="fleet-files-permission"
                >
                    <Lock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    {t('states.permissionDenied', { node: node.name })}
                </p>
            ) : (
                <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={onDrop}
                    title={t('actions.dropHint', { folder: folderLabel })}
                >
                    {listError ? (
                        <div
                            role="status"
                            className="rounded-xl border border-border dark:border-border-dark p-4 text-sm space-y-2"
                        >
                            <p className="text-text dark:text-text-dark">
                                {listError.hint ?? t('states.listError', { node: node.name })}
                            </p>
                            <Button size="sm" variant="secondary" onClick={() => void loadList()}>
                                {t('states.tryAgain')}
                            </Button>
                        </div>
                    ) : !list && (loading || !roots) ? (
                        <p
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            role="status"
                        >
                            {roots
                                ? t('loading', { folder: folderLabel })
                                : t('roots.loading', { node: node.name })}
                        </p>
                    ) : (
                        <FilesGrid
                            entries={entries}
                            selected={selected}
                            folderLabel={folderLabel}
                            canGoUp={path.length > 0}
                            disabled={false}
                            onToggle={toggle}
                            onToggleAll={toggleAll}
                            onOpen={open}
                            onUp={up}
                        />
                    )}
                    {list?.truncated && (
                        <p className="mt-1 text-xs text-warning" role="status">
                            {t('grid.truncated', { shown: list.entries.length, total: list.total })}
                        </p>
                    )}
                </div>
            )}

            {!permissionDenied && (
                <div
                    className="flex flex-wrap items-center gap-2 text-sm"
                    data-testid="fleet-files-actions"
                >
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {selection.length > 0
                            ? t('actions.selected', {
                                  count: selection.length,
                                  size: formatFileBytes(selectionBytes),
                              })
                            : t('grid.keyboardHint')}
                    </span>
                    <span className="flex-1" />
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={selection.length === 0 || tooMany || checking}
                        onClick={() => void download()}
                        title={tooMany ? t('actions.tooMany') : undefined}
                        data-testid="fleet-files-download"
                    >
                        <Download className="w-4 h-4" aria-hidden="true" />
                        {checking ? t('actions.checking') : t('actions.download')}
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={!root}
                        onClick={() => filesInput.current?.click()}
                    >
                        <Upload className="w-4 h-4" aria-hidden="true" />
                        {t('actions.upload')}
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={!root}
                        onClick={() => folderInput.current?.click()}
                    >
                        <FolderUp className="w-4 h-4" aria-hidden="true" />
                        {t('actions.uploadFolder')}
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={selection.length === 0 || tooMany}
                        onClick={() => setCopying(selection.map((entry) => entry.name))}
                        data-testid="fleet-files-copy-open"
                    >
                        <ArrowLeftRight className="w-4 h-4" aria-hidden="true" />
                        {t('actions.copy')}
                    </Button>
                    <Button
                        size="sm"
                        variant="danger"
                        disabled={selection.length === 0 || tooMany}
                        onClick={startDelete}
                        data-testid="fleet-files-delete-open"
                    >
                        <Trash2 className="w-4 h-4" aria-hidden="true" />
                        {t('actions.delete')}
                    </Button>
                    <input
                        ref={filesInput}
                        type="file"
                        multiple
                        hidden
                        onChange={(event) => {
                            void upload(picksFrom(event.target.files, false));
                            event.target.value = '';
                        }}
                    />
                    <input
                        ref={(element) => {
                            folderInput.current = element;
                            // `webkitdirectory` is not in React's typings; set it on the element.
                            if (element) element.setAttribute('webkitdirectory', '');
                        }}
                        type="file"
                        multiple
                        hidden
                        onChange={(event) => {
                            void upload(picksFrom(event.target.files, true));
                            event.target.value = '';
                        }}
                    />
                </div>
            )}

            <FilesOperationsStrip
                nodeName={node.name}
                transfers={transfers?.transfers ?? []}
                uploads={uploads}
                onCancel={(view) => void cancelTransfer(view)}
            />

            {summary && (
                <footer
                    className="space-y-0.5 text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-files-footer"
                >
                    <p>
                        {t('footer.roots', { node: node.name, list: rootsList })}{' '}
                        <a
                            href={FLEET_FILES_DOCS_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                        >
                            {t('footer.howRoots')}
                        </a>
                    </p>
                    <p>
                        {current
                            ? t('footer.cost', { current: formatFileBytes(current.bytes), today })
                            : t('footer.costIdle', { today })}
                    </p>
                </footer>
            )}

            <p className="sr-only" aria-live="polite" role="status" aria-label={t('a11y.notices')}>
                {announcement}
            </p>

            {credential && (
                <FilesCredentialDialog
                    open
                    names={credential.names}
                    count={credential.count}
                    copy={Boolean(credential.copy)}
                    onCancel={() => setCredential(null)}
                    onConfirm={() => {
                        const names = credential.entries;
                        const copy = credential.copy;
                        setCredential(null);
                        if (copy) void sendCopy(names, copy.target, copy.policy, true);
                        else startDownload(names, true);
                    }}
                />
            )}
            {conflicts && (
                <FilesConflictDialog
                    open
                    conflicts={conflicts.items}
                    total={conflicts.total}
                    folder={
                        conflicts.copy
                            ? conflicts.copy.target.rootLabel +
                              (conflicts.copy.target.path ? ' / ' + conflicts.copy.target.path : '')
                            : folderLabel
                    }
                    nodeName={conflicts.copy ? conflicts.copy.target.nodeName : node.name}
                    onCancel={() => setConflicts(null)}
                    onConfirm={(policy) => {
                        const picks = conflicts.picks;
                        const copy = conflicts.copy;
                        setConflicts(null);
                        if (copy) void sendCopy(copy.names, copy.target, policy, false);
                        else sendUpload(picks, policy);
                    }}
                />
            )}
            {copying && (
                <FilesCopyDialog
                    open
                    source={{ id: node.id, name: node.name }}
                    names={copying}
                    bytes={entries
                        .filter((entry) => copying.includes(entry.name))
                        .reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0)}
                    onCancel={() => setCopying(null)}
                    onSubmit={(target) => {
                        const names = copying;
                        setCopying(null);
                        void startCopy(names, target);
                    }}
                />
            )}
            {deleting && (
                <FilesDeleteDialog
                    open
                    names={deleting.names}
                    expected={deleting.expected}
                    folder={folderLabel}
                    nodeName={node.name}
                    pending={deletePending}
                    error={deleteError}
                    onCancel={() => setDeleting(null)}
                    onConfirm={(typed) => void confirmDelete(typed)}
                />
            )}
        </div>
    );
}

function FilesStateCard({
    card,
    nodeName,
    locale,
    onRetry,
}: {
    card: FilesTabCard;
    nodeName: string;
    locale: string;
    onRetry(): void;
}) {
    const t = useTranslations('fleet.files.states');
    const frame =
        'rounded-xl border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark p-4 flex gap-3';
    const muted = 'w-5 h-5 shrink-0 text-text-muted dark:text-text-muted-dark';
    const body = (() => {
        switch (card.kind) {
            case 'desktop-node':
                return {
                    icon: <MonitorSmartphone className={muted} aria-hidden="true" />,
                    content: (
                        <p className="text-sm text-text dark:text-text-dark">{t('desktopNode')}</p>
                    ),
                };
            case 'offline': {
                const relative = relativeTime(card.lastSeenAt, new Date(), locale);
                return {
                    icon: <WifiOff className={muted} aria-hidden="true" />,
                    content: (
                        <div className="space-y-2">
                            <p className="text-sm text-text dark:text-text-dark">
                                {relative
                                    ? t('offline', { node: nodeName, relative })
                                    : t('offlineNever', { node: nodeName })}
                            </p>
                            <Button size="sm" variant="secondary" onClick={onRetry}>
                                {t('tryAgain')}
                            </Button>
                        </div>
                    ),
                };
            }
            case 'consent-missing':
                return {
                    icon: (
                        <ShieldOff className="w-5 h-5 shrink-0 text-warning" aria-hidden="true" />
                    ),
                    content: (
                        <div className="space-y-2 min-w-0">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('consentMissing', { node: nodeName })}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('consentCommand', { node: nodeName })}
                            </p>
                            <CopyCommand
                                command={card.command}
                                testId="fleet-files-consent-command"
                            />
                        </div>
                    ),
                };
            case 'no-roots':
                return {
                    icon: <ShieldOff className={muted} aria-hidden="true" />,
                    content: (
                        <div className="space-y-2 min-w-0">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('noRoots', { node: nodeName })}
                            </p>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('noRootsCommand', { node: nodeName })}
                            </p>
                            <CopyCommand command={card.command} testId="fleet-files-root-command" />
                        </div>
                    ),
                };
            case 'kill-switch':
                return {
                    icon: <OctagonX className="w-5 h-5 shrink-0 text-danger" aria-hidden="true" />,
                    content: (
                        <p className="text-sm text-text dark:text-text-dark">{t('killSwitch')}</p>
                    ),
                };
            case 'unreachable':
                return {
                    icon: <WifiOff className={muted} aria-hidden="true" />,
                    content: (
                        <div className="space-y-2">
                            <p className="text-sm text-text dark:text-text-dark">
                                {card.hint ?? t('unreachable', { node: nodeName })}
                            </p>
                            <Button size="sm" variant="secondary" onClick={onRetry}>
                                {t('tryAgain')}
                            </Button>
                        </div>
                    ),
                };
            case 'permission-denied':
                return {
                    icon: <Lock className={muted} aria-hidden="true" />,
                    content: (
                        <p className="text-sm text-text dark:text-text-dark">
                            {t('permissionDenied', { node: nodeName })}
                        </p>
                    ),
                };
            default:
                return {
                    icon: <OctagonX className="w-5 h-5 shrink-0 text-danger" aria-hidden="true" />,
                    content: (
                        <div className="space-y-2">
                            <p className="text-sm text-text dark:text-text-dark">
                                {t('listError', { node: nodeName })}
                            </p>
                            {card.hint && (
                                <p className="text-xs text-text-muted dark:text-text-muted-dark font-mono">
                                    {card.hint}
                                </p>
                            )}
                            <Button size="sm" variant="secondary" onClick={onRetry}>
                                {t('tryAgain')}
                            </Button>
                        </div>
                    ),
                };
        }
    })();
    return (
        <div role="status" className={frame} data-testid="fleet-files-card" data-card={card.kind}>
            {body.icon}
            {body.content}
        </div>
    );
}
