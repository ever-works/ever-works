'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CornerLeftUp, Folder } from 'lucide-react';
import {
    normalizeFleetFileRelativePath,
    type FleetFileListView,
    type FleetFileRootsResponse,
    type FleetNodeView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { listVisibleFleetNodesAction } from '@/app/actions/settings/fleet';
import { browserApiFetch } from '@/lib/api/browser-api';
import { readSessionError } from '../sessions/sessions.shared';
import {
    copyDestinationReason,
    filesApiPath,
    formatFileBytes,
    parentFilePath,
    sortFileEntries,
} from './files.shared';

export interface FilesCopyTarget {
    nodeId: string;
    nodeName: string;
    root: string;
    rootLabel: string;
    path: string;
}

/**
 * Files on computers (FL-11 P2, spec §5.5, T-18) — "Copy to another
 * computer…": pick the destination computer (offline or unmanaged ones are
 * listed greyed with their reason), one of its roots and a folder under it
 * (typed, or browsed folder by folder). The copy goes through Ever Works — the
 * dialog says so in the computers' own names. **Check and copy** asks the
 * destination for same-name entries first (the tab shows them before anything
 * is written).
 */
export function FilesCopyDialog({
    open,
    source,
    names,
    bytes,
    onCancel,
    onSubmit,
}: {
    open: boolean;
    source: { id: string; name: string };
    names: readonly string[];
    bytes: number;
    onCancel(): void;
    onSubmit(target: FilesCopyTarget): void;
}) {
    const t = useTranslations('fleet.files.copy');
    const [nodes, setNodes] = useState<FleetNodeView[] | null>(null);
    const [nodeId, setNodeId] = useState<string>('');
    const [roots, setRoots] = useState<FleetFileRootsResponse | null>(null);
    const [rootsError, setRootsError] = useState<string | null>(null);
    const [rootId, setRootId] = useState<string>('');
    const [path, setPath] = useState('');
    const [folders, setFolders] = useState<string[]>([]);

    useEffect(() => {
        let cancelled = false;
        void listVisibleFleetNodesAction().then((result) => {
            if (cancelled) return;
            const list = result.success
                ? result.data.filter((node) => node.persisted && node.status !== 'enrolling')
                : [];
            setNodes(list);
            const first = list.find(
                (node) => node.id !== source.id && copyDestinationReason(node) === null,
            );
            if (first) setNodeId(first.id);
        });
        return () => {
            cancelled = true;
        };
    }, [source.id]);

    useEffect(() => {
        if (!nodeId) return;
        let cancelled = false;
        setRoots(null);
        setRootsError(null);
        setRootId('');
        setPath('');
        void browserApiFetch(filesApiPath(nodeId, 'roots'), { method: 'GET', cache: 'no-store' })
            .then(async (response) => {
                const body = (await response.json().catch(() => null)) as unknown;
                if (cancelled) return;
                if (!response.ok) {
                    const read = readSessionError(response.status, body);
                    setRootsError(read.hint ?? read.code);
                    return;
                }
                const value = body as FleetFileRootsResponse;
                setRoots(value);
                setRootId(value.roots[0]?.id ?? '');
            })
            .catch(() => !cancelled && setRootsError(t('unreachable')));
        return () => {
            cancelled = true;
        };
    }, [nodeId, t]);

    useEffect(() => {
        if (!nodeId || !rootId) return;
        let cancelled = false;
        void browserApiFetch(filesApiPath(nodeId, 'list', { root: rootId, path }), {
            method: 'GET',
            cache: 'no-store',
        })
            .then(async (response) => {
                if (cancelled || !response.ok) return;
                const list = (await response.json()) as FleetFileListView;
                setFolders(
                    sortFileEntries(list.entries)
                        .filter((entry) => entry.kind === 'folder')
                        .map((entry) => entry.name)
                        .slice(0, 200),
                );
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [nodeId, rootId, path]);

    const target = useMemo(
        () => nodes?.find((node) => node.id === nodeId) ?? null,
        [nodes, nodeId],
    );
    const root = roots?.roots.find((candidate) => candidate.id === rootId) ?? null;
    const normalized = normalizeFleetFileRelativePath(path);
    const ready = Boolean(target && root && normalized !== null);

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
            <DialogContent data-testid="fleet-files-copy">
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {t('title', {
                            count: names.length,
                            size: formatFileBytes(bytes),
                            node: source.name,
                        })}
                    </DialogTitle>
                    <DialogDescription>
                        {t('through', { from: source.name, to: target?.name ?? t('another') })}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 text-sm">
                    <label className="block space-y-1">
                        <span className="text-text-muted dark:text-text-muted-dark">
                            {t('computer')}
                        </span>
                        <select
                            value={nodeId}
                            onChange={(event) => setNodeId(event.target.value)}
                            className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-2 py-1"
                            data-testid="fleet-files-copy-node"
                        >
                            {!nodes && <option value="">{t('loading')}</option>}
                            {(nodes ?? []).map((node) => {
                                const reason = copyDestinationReason(node);
                                return (
                                    <option
                                        key={node.id}
                                        value={node.id}
                                        disabled={reason !== null}
                                    >
                                        {reason
                                            ? t('nodeUnavailable', {
                                                  name: node.name,
                                                  reason: t(`reasons.${reason}`),
                                              })
                                            : node.name}
                                    </option>
                                );
                            })}
                        </select>
                    </label>
                    <label className="block space-y-1">
                        <span className="text-text-muted dark:text-text-muted-dark">
                            {t('root')}
                        </span>
                        <select
                            value={rootId}
                            disabled={!roots}
                            onChange={(event) => {
                                setRootId(event.target.value);
                                setPath('');
                            }}
                            className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-2 py-1"
                            data-testid="fleet-files-copy-root"
                        >
                            {(roots?.roots ?? []).map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                    {candidate.label}
                                </option>
                            ))}
                        </select>
                        {rootsError && (
                            <span className="block text-xs text-danger" role="alert">
                                {rootsError}
                            </span>
                        )}
                    </label>
                    <label className="block space-y-1">
                        <span className="text-text-muted dark:text-text-muted-dark">
                            {t('folder')}
                        </span>
                        <input
                            type="text"
                            value={path}
                            onChange={(event) => setPath(event.target.value)}
                            placeholder="/"
                            className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-2 py-1 font-mono"
                            data-testid="fleet-files-copy-path"
                        />
                        {normalized === null && (
                            <span className="block text-xs text-danger" role="alert">
                                {t('badFolder')}
                            </span>
                        )}
                    </label>
                    {root && normalized !== null && (
                        <ul
                            className="max-h-40 overflow-auto rounded-md border border-border dark:border-border-dark text-xs"
                            aria-label={t('browse')}
                        >
                            {normalized && (
                                <li>
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2 px-2 py-1 hover:bg-primary/5"
                                        onClick={() => setPath(parentFilePath(normalized))}
                                    >
                                        <CornerLeftUp className="w-3 h-3" aria-hidden="true" />
                                        ..
                                    </button>
                                </li>
                            )}
                            {folders.map((folder) => (
                                <li key={folder}>
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2 px-2 py-1 hover:bg-primary/5"
                                        onClick={() =>
                                            setPath(normalized ? `${normalized}/${folder}` : folder)
                                        }
                                    >
                                        <Folder
                                            className="w-3 h-3 text-primary"
                                            aria-hidden="true"
                                        />
                                        {folder}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onCancel}>
                        {t('cancel')}
                    </Button>
                    <Button
                        disabled={!ready}
                        onClick={() =>
                            target &&
                            root &&
                            normalized !== null &&
                            onSubmit({
                                nodeId: target.id,
                                nodeName: target.name,
                                root: root.id,
                                rootLabel: root.label,
                                path: normalized,
                            })
                        }
                        data-testid="fleet-files-copy-submit"
                    >
                        {t('submit')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
