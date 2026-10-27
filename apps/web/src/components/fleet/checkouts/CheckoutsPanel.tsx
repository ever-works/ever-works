'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    Archive,
    ArrowDownToLine,
    ArrowUpFromLine,
    Download,
    FolderGit2,
    Plus,
    RefreshCw,
    RotateCcw,
    ScanSearch,
    Trash2,
} from 'lucide-react';
import {
    FLEET_CHECKOUTS_DISCOVERY_CAP,
    type FleetCheckoutView,
    type FleetNodeCheckoutsMeta,
    type FleetNodeView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import {
    archiveCheckoutAction,
    deleteCheckoutAction,
    listFleetCheckoutsAction,
    listNodeCheckoutsAction,
    refreshCheckoutAction,
    restoreCheckoutAction,
    syncCheckoutAction,
    type CheckoutActionResult,
} from '@/app/actions/fleet-checkouts';
import { CopyCommand } from '../link/CopyCommand';
import {
    DeleteCheckoutDialog,
    readDeletePreview,
    type CheckoutDeletePreview,
} from './DeleteCheckoutDialog';
import { CleanUpButton } from '../sessions/CleanUpButton';
import { canCleanUp } from '../sessions/session-git.shared';
import { GitLine } from './GitLine';
import { NewCheckoutDialog } from './NewCheckoutDialog';
import {
    ageParts,
    checkoutActionState,
    checkoutRowActions,
    checkoutsPollMs,
    formatCheckoutSize,
    groupCheckoutsByRepository,
    homeRelativePath,
    isComputerOnline,
    mayManageCheckouts,
    totalCheckoutBytes,
    type CheckoutRowAction,
} from './checkouts.shared';

/** What the server component read before paint. */
export interface CheckoutsPanelInitial {
    rows: FleetCheckoutView[];
    bin: number;
    meta?: FleetNodeCheckoutsMeta | null;
    stale?: { code: string; hint: string } | null;
    error?: { code: string | null; hint: string | null } | null;
}

export interface CheckoutsPanelProps {
    /** `hub` — Fleet → Checkouts, every computer grouped by repository; `computer` — one computer's tab. */
    mode: 'hub' | 'computer';
    /** Every computer the viewer may see (hub), or exactly the one (computer page). */
    nodes: FleetNodeView[];
    initial: CheckoutsPanelInitial;
}

type RowNotice = { tone: 'ok' | 'error'; text: string };

const ACTION_ICONS: Record<CheckoutRowAction, typeof Download> = {
    fetch: Download,
    pull: ArrowDownToLine,
    push: ArrowUpFromLine,
    refresh: RefreshCw,
    archive: Archive,
    restore: RotateCcw,
    delete: Trash2,
    forget: Trash2,
};

const CODE_FOLDER_COMMAND = 'ever-works-node start --manage --code-folder ~/code';

/**
 * Checkouts on computers (FL-14, spec §5.1, §5.2) — the one panel both tabs
 * render: rows grouped by repository (hub) or one computer's rows with its
 * Code folders card (computer page), the bin, and the P1 actions — Refresh,
 * Fetch, Archive, Restore, Scan. Every action is the server's to allow; a
 * row only says beforehand why one is off (offline, `--manage` missing, not
 * the owner, in the bin, gone). A refusal is shown inline on its row, never
 * as a toast alone (spec §5.1 "error"). Re-reads every 10 s while something
 * is running on a machine, else every 60 s.
 */
export function CheckoutsPanel({ mode, nodes, initial }: CheckoutsPanelProps) {
    const t = useTranslations('fleet.checkouts');
    const [rows, setRows] = useState<FleetCheckoutView[]>(initial.rows);
    const [bin, setBin] = useState<number>(initial.bin);
    const [meta, setMeta] = useState<FleetNodeCheckoutsMeta | null>(initial.meta ?? null);
    const [stale, setStale] = useState<{ code: string; hint: string } | null>(
        initial.stale ?? null,
    );
    const [error, setError] = useState<{ code: string | null; hint: string | null } | null>(
        initial.error ?? null,
    );
    const [showBin, setShowBin] = useState(false);
    const [binRows, setBinRows] = useState<FleetCheckoutView[] | null>(null);
    const [pending, setPending] = useState<Set<string>>(new Set());
    const [notices, setNotices] = useState<Record<string, RowNotice>>({});
    const [confirming, setConfirming] = useState<{
        id: string;
        action: 'archive' | 'pull' | 'push';
    } | null>(null);
    const [deleting, setDeleting] = useState<{
        id: string;
        mode: 'delete' | 'forget';
        preview: CheckoutDeletePreview;
    } | null>(null);
    const [creating, setCreating] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [nodeFilter, setNodeFilter] = useState<string>('all');
    // Ages ("found 2 h ago") are computed after mount only, so the server's
    // render and the browser's first render agree.
    const [now, setNow] = useState<number | null>(null);
    useEffect(() => {
        setNow(Date.now());
    }, [rows, binRows]);

    const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const single = mode === 'computer' ? (nodes[0] ?? null) : null;

    const describeRefusal = useCallback(
        (result: CheckoutActionResult<unknown>): string => {
            if (result.success) return '';
            const title = result.code
                ? t(`errorTitles.${errorTitleKey(result.code)}`)
                : t('errorTitles.internal');
            return result.hint ? `${title} — ${result.hint}` : title;
        },
        [t],
    );

    const reload = useCallback(async () => {
        if (mode === 'computer' && single) {
            const result = await listNodeCheckoutsAction(single.id);
            if (result.success) {
                setRows(result.data.data);
                setBin(result.data.meta.bin);
                setMeta(result.data.node);
                setStale(result.data.stale ?? null);
                setError(null);
            } else {
                setError({ code: result.code, hint: result.hint });
            }
            return;
        }
        const result = await listFleetCheckoutsAction();
        if (result.success) {
            setRows(result.data.data);
            setBin(result.data.meta.bin);
            setError(null);
        } else {
            setError({ code: result.code, hint: result.hint });
        }
    }, [mode, single]);

    const pollMs = checkoutsPollMs(rows);
    useEffect(() => {
        const timer = setInterval(() => {
            void reload();
        }, pollMs);
        return () => clearInterval(timer);
    }, [pollMs, reload]);

    const markPending = (id: string, on: boolean) =>
        setPending((current) => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });

    const replaceRow = (updated: FleetCheckoutView) => {
        setRows((current) => {
            if (updated.state === 'archived') return current.filter((row) => row.id !== updated.id);
            const exists = current.some((row) => row.id === updated.id);
            return exists
                ? current.map((row) => (row.id === updated.id ? updated : row))
                : [...current, updated];
        });
    };

    const runRowAction = async (row: FleetCheckoutView, action: CheckoutRowAction) => {
        markPending(row.id, true);
        setNotices((current) => {
            const next = { ...current };
            delete next[row.id];
            return next;
        });
        try {
            if (action === 'delete' || action === 'forget') {
                // First ask: the computer says what would be lost (CONTRACTS §2.2 preview).
                const result = await deleteCheckoutAction(row.id, { mode: action });
                if (!result.success && result.code === 'confirmation_required') {
                    const preview = readDeletePreview(result.details);
                    if (preview) {
                        setDeleting({ id: row.id, mode: action, preview });
                        return;
                    }
                }
                if (!result.success) {
                    setNotices((current) => ({
                        ...current,
                        [row.id]: { tone: 'error', text: describeRefusal(result) },
                    }));
                }
                return;
            }
            if (
                action === 'refresh' ||
                action === 'fetch' ||
                action === 'pull' ||
                action === 'push'
            ) {
                const result =
                    action === 'refresh'
                        ? await refreshCheckoutAction(row.id)
                        : await syncCheckoutAction(
                              row.id,
                              action,
                              action === 'fetch' ? undefined : true,
                          );
                setConfirming(null);
                if (result.success) {
                    replaceRow(result.data.checkout);
                    const last = result.data.checkout.lastCommand;
                    const text = result.data.operationId
                        ? t('notices.running')
                        : action !== 'refresh' &&
                            last &&
                            last.exitCode !== null &&
                            last.exitCode !== 0
                          ? t('notices.syncFailed', {
                                op: action,
                                code: last.exitCode,
                                line: last.stderrHead ?? '',
                            })
                          : t(
                                `notices.${action === 'refresh' ? 'refreshed' : action === 'fetch' ? 'fetched' : action === 'pull' ? 'pulled' : 'pushed'}`,
                            );
                    const tone =
                        action !== 'refresh' &&
                        last &&
                        last.exitCode !== null &&
                        last.exitCode !== 0;
                    setNotices((current) => ({
                        ...current,
                        [row.id]: { tone: tone ? 'error' : 'ok', text },
                    }));
                } else {
                    setNotices((current) => ({
                        ...current,
                        [row.id]: { tone: 'error', text: describeRefusal(result) },
                    }));
                }
            } else if (action === 'archive') {
                const result = await archiveCheckoutAction(row.id, true);
                setConfirming(null);
                if (result.success) {
                    replaceRow(result.data);
                    setBin((count) => count + 1);
                    setBinRows(null);
                } else {
                    setNotices((current) => ({
                        ...current,
                        [row.id]: { tone: 'error', text: describeRefusal(result) },
                    }));
                }
            } else if (action === 'restore') {
                const result = await restoreCheckoutAction(row.id);
                if (result.success) {
                    setBinRows(
                        (current) => current?.filter((entry) => entry.id !== row.id) ?? null,
                    );
                    setBin((count) => Math.max(0, count - 1));
                    replaceRow(result.data);
                } else {
                    setNotices((current) => ({
                        ...current,
                        [row.id]: { tone: 'error', text: describeRefusal(result) },
                    }));
                }
            }
        } finally {
            markPending(row.id, false);
        }
    };

    const scan = async () => {
        setScanning(true);
        try {
            const targets = single
                ? [single]
                : nodes.filter(
                      (node) =>
                          isComputerOnline(node) &&
                          node.consents?.manage === true &&
                          mayManageCheckouts(node),
                  );
            for (const node of targets.slice(0, 20)) {
                const result = await listNodeCheckoutsAction(node.id, { rescan: true });
                if (!result.success) {
                    setError({ code: result.code, hint: result.hint });
                    break;
                }
                if (single) {
                    setMeta(result.data.node);
                    setStale(result.data.stale ?? null);
                }
            }
            await reload();
        } finally {
            setScanning(false);
        }
    };

    const openBin = async () => {
        const next = !showBin;
        setShowBin(next);
        if (!next || binRows !== null) return;
        const result = single
            ? await listNodeCheckoutsAction(single.id, { state: 'archived' })
            : await listFleetCheckoutsAction({ state: 'archived' });
        if (result.success) setBinRows(result.data.data);
        else setError({ code: result.code, hint: result.hint });
    };

    const visible = rows.filter((row) => nodeFilter === 'all' || row.nodeId === nodeFilter);
    const groups = groupCheckoutsByRepository(visible);
    const offlineNodes = nodes.filter(
        (node) => !isComputerOnline(node) && rows.some((row) => row.nodeId === node.id),
    );
    const manageMissing = single && single.consents && single.consents.manage === false;
    const canScan = single
        ? isComputerOnline(single) && !manageMissing && mayManageCheckouts(single)
        : nodes.some((node) => isComputerOnline(node) && node.consents?.manage === true);

    return (
        <section className="space-y-4" data-testid={`fleet-checkouts-${mode}`}>
            <header className="flex flex-wrap items-center gap-2">
                <h2 className="mr-auto text-sm font-semibold">
                    {t(mode === 'hub' ? 'hub.title' : 'tab.title')}
                </h2>
                {mode === 'hub' && nodes.length > 1 ? (
                    <label className="flex items-center gap-1 text-xs">
                        <span>{t('hub.computerFilter')}</span>
                        <select
                            className="rounded border border-border bg-transparent px-1 py-0.5 dark:border-border-dark"
                            value={nodeFilter}
                            onChange={(event) => setNodeFilter(event.target.value)}
                            data-testid="fleet-checkouts-node-filter"
                        >
                            <option value="all">{t('hub.allComputers')}</option>
                            {nodes.map((node) => (
                                <option key={node.id} value={node.id}>
                                    {node.name}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void scan()}
                    disabled={!canScan || scanning}
                    title={canScan ? undefined : t('disabled.scan')}
                    data-testid="fleet-checkouts-scan"
                >
                    <ScanSearch className="mr-1 h-4 w-4" aria-hidden />
                    {scanning
                        ? t('actions.scanning')
                        : t(mode === 'hub' ? 'actions.scanAll' : 'actions.scan')}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setCreating((open) => !open)}
                    aria-expanded={creating}
                    disabled={
                        !nodes.some(
                            (node) => isComputerOnline(node) && node.consents?.manage === true,
                        )
                    }
                    title={t('disabled.scan')}
                    data-testid="fleet-checkouts-new"
                >
                    <Plus className="mr-1 h-4 w-4" aria-hidden />
                    {t('actions.new')}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void openBin()}
                    aria-pressed={showBin}
                    data-testid="fleet-checkouts-bin-toggle"
                >
                    <Archive className="mr-1 h-4 w-4" aria-hidden />
                    {t('bin.toggle', { count: bin })}
                </Button>
            </header>

            {creating ? (
                <NewCheckoutDialog
                    nodes={nodes}
                    rows={rows}
                    onCreated={(checkout) => replaceRow(checkout)}
                    onClose={() => setCreating(false)}
                />
            ) : null}

            {error ? (
                <p
                    role="alert"
                    className="text-sm text-red-600 dark:text-red-400"
                    data-testid="fleet-checkouts-error"
                >
                    {error.code
                        ? t(`errorTitles.${errorTitleKey(error.code)}`)
                        : t('errorTitles.internal')}
                    {error.hint ? ` — ${error.hint}` : ''}
                </p>
            ) : null}

            {single && manageMissing ? (
                <div
                    className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40"
                    data-testid="fleet-checkouts-consent-banner"
                >
                    <p>{t('states.consentMissing', { name: single.name })}</p>
                    <CopyCommand
                        command="ever-works-node start --manage"
                        testId="fleet-checkouts-consent-command"
                    />
                </div>
            ) : null}

            {single && stale && stale.code === 'unreachable' ? (
                <p
                    className="text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-checkouts-stale"
                >
                    {t('states.offline', {
                        name: single.name,
                        count: rows.length,
                        age: formatAge(
                            t,
                            now === null ? null : ageParts(single.lastHeartbeatAt, now),
                        ),
                    })}
                </p>
            ) : null}
            {single && stale && stale.code !== 'unreachable' ? (
                <p
                    className="text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-checkouts-stale"
                >
                    {t('states.lastKnown', { hint: stale.hint })}
                </p>
            ) : null}

            {single ? <CodeFolders meta={meta} node={single} rows={rows} now={now} /> : null}

            {groups.length === 0 ? (
                <div
                    className="rounded-lg border border-dashed border-border p-6 text-center text-sm dark:border-border-dark"
                    data-testid="fleet-checkouts-empty"
                >
                    <FolderGit2 className="mx-auto mb-2 h-6 w-6 text-text-muted" aria-hidden />
                    <p>{t('states.empty')}</p>
                </div>
            ) : (
                groups.map((group) => (
                    <div key={group.key} className="space-y-1" data-testid="fleet-checkouts-group">
                        <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
                            <span>
                                {group.kind === 'unlinked'
                                    ? t('group.unlinked')
                                    : group.kind === 'work'
                                      ? t('group.work', { name: group.label ?? '' })
                                      : group.label}
                            </span>
                            {group.kind === 'work' && group.repository ? (
                                <span className="font-mono text-xs text-text-muted dark:text-text-muted-dark">
                                    {group.repository}
                                </span>
                            ) : null}
                            {group.kind === 'repository' ? (
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('group.noWork')}
                                </span>
                            ) : null}
                            <span className="ml-auto text-xs text-text-muted dark:text-text-muted-dark">
                                {t('group.count', {
                                    count: group.rows.length,
                                    computers: group.computers,
                                })}
                            </span>
                        </h3>
                        <ul className="divide-y divide-border rounded-lg border border-border dark:divide-border-dark dark:border-border-dark">
                            {group.rows.map((row) => (
                                <CheckoutRow
                                    key={row.id}
                                    row={row}
                                    node={nodesById.get(row.nodeId) ?? null}
                                    showComputer={mode === 'hub'}
                                    pending={pending.has(row.id)}
                                    notice={notices[row.id] ?? null}
                                    confirming={
                                        confirming?.id === row.id ? confirming.action : null
                                    }
                                    now={now}
                                    onAction={(action) => {
                                        if (
                                            (action === 'archive' ||
                                                action === 'pull' ||
                                                action === 'push') &&
                                            !(
                                                confirming?.id === row.id &&
                                                confirming.action === action
                                            )
                                        ) {
                                            setConfirming({ id: row.id, action });
                                            return;
                                        }
                                        void runRowAction(row, action);
                                    }}
                                    onCancelConfirm={() => setConfirming(null)}
                                    deleting={deleting?.id === row.id ? deleting : null}
                                    onDeleted={(result) => {
                                        setDeleting(null);
                                        setRows((current) =>
                                            current.filter((entry) => entry.id !== row.id),
                                        );
                                        if (!result.forgotten) {
                                            setBin((count) => count + 1);
                                            setBinRows(null);
                                        }
                                    }}
                                    onCancelDelete={() => setDeleting(null)}
                                />
                            ))}
                        </ul>
                    </div>
                ))
            )}

            {mode === 'hub' && offlineNodes.length > 0 ? (
                <ul className="space-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                    {offlineNodes.map((node) => (
                        <li key={node.id} data-testid="fleet-checkouts-offline-note">
                            {t('states.offline', {
                                name: node.name,
                                count: rows.filter((row) => row.nodeId === node.id).length,
                                age: formatAge(
                                    t,
                                    now === null ? null : ageParts(node.lastHeartbeatAt, now),
                                ),
                            })}
                        </li>
                    ))}
                </ul>
            ) : null}

            {showBin ? (
                <div className="space-y-1" data-testid="fleet-checkouts-bin">
                    <h3 className="text-sm font-medium">{t('bin.title')}</h3>
                    {binRows === null ? (
                        <p className="text-xs text-text-muted">{t('states.loading')}</p>
                    ) : binRows.length === 0 ? (
                        <p className="text-xs text-text-muted">{t('bin.empty')}</p>
                    ) : (
                        <ul className="divide-y divide-border rounded-lg border border-border dark:divide-border-dark dark:border-border-dark">
                            {binRows.map((row) => (
                                <CheckoutRow
                                    key={row.id}
                                    row={row}
                                    node={nodesById.get(row.nodeId) ?? null}
                                    showComputer={mode === 'hub'}
                                    pending={pending.has(row.id)}
                                    notice={notices[row.id] ?? null}
                                    confirming={null}
                                    now={now}
                                    onAction={(action) => void runRowAction(row, action)}
                                    onCancelConfirm={() => undefined}
                                    deleting={deleting?.id === row.id ? deleting : null}
                                    onDeleted={(result) => {
                                        setDeleting(null);
                                        setBinRows(
                                            (current) =>
                                                current
                                                    ?.map((entry) =>
                                                        entry.id === row.id && result.checkout
                                                            ? result.checkout
                                                            : entry,
                                                    )
                                                    .filter(
                                                        (entry) =>
                                                            !(
                                                                result.forgotten &&
                                                                entry.id === row.id
                                                            ),
                                                    ) ?? null,
                                        );
                                        if (result.forgotten)
                                            setBin((count) => Math.max(0, count - 1));
                                    }}
                                    onCancelDelete={() => setDeleting(null)}
                                />
                            ))}
                        </ul>
                    )}
                </div>
            ) : null}
        </section>
    );
}

type ErrorTitleKey =
    | 'notFound'
    | 'invalid'
    | 'unreachable'
    | 'consentMissing'
    | 'permissionDenied'
    | 'confirmationRequired'
    | 'killSwitch'
    | 'limitExceeded'
    | 'unsupportedOnNode'
    | 'busy'
    | 'operationFailed'
    | 'internal';

/** CONTRACTS §8 code → its `fleet.checkouts.errorTitles.*` key (camelCase, no literal dots). */
function errorTitleKey(code: string): ErrorTitleKey {
    switch (code) {
        case 'not_found':
            return 'notFound';
        case 'invalid':
            return 'invalid';
        case 'unreachable':
            return 'unreachable';
        case 'consent_missing':
            return 'consentMissing';
        case 'permission_denied':
            return 'permissionDenied';
        case 'confirmation_required':
            return 'confirmationRequired';
        case 'kill_switch':
            return 'killSwitch';
        case 'limit_exceeded':
            return 'limitExceeded';
        case 'unsupported_on_node':
            return 'unsupportedOnNode';
        case 'busy':
            return 'busy';
        case 'operation_failed':
            return 'operationFailed';
        default:
            return 'internal';
    }
}

type Translator = ReturnType<typeof useTranslations>;

function formatAge(t: Translator, age: ReturnType<typeof ageParts>): string {
    if (!age) return t('age.unknown');
    return t(`age.${age.unit}`, { value: age.value });
}

function CodeFolders({
    meta,
    node,
    rows,
    now,
}: {
    meta: FleetNodeCheckoutsMeta | null;
    node: FleetNodeView;
    rows: FleetCheckoutView[];
    now: number | null;
}) {
    const t = useTranslations('fleet.checkouts.codeFolders');
    const tAge = useTranslations('fleet.checkouts');
    const folders = meta?.codeFolders ?? null;
    const total = formatCheckoutSize(meta?.totalSizeBytes ?? totalCheckoutBytes(rows));
    const discovered = rows.filter((row) => row.kind === 'discovered').length;
    return (
        <div
            className="space-y-2 rounded-lg border border-border p-3 text-sm dark:border-border-dark"
            data-testid="fleet-checkouts-code-folders"
        >
            <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="font-medium">{t('title')}</h3>
                {total ? (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('total', { size: total })}
                    </span>
                ) : null}
                <span className="ml-auto text-xs text-text-muted dark:text-text-muted-dark">
                    {meta?.scannedAt
                        ? t('lastScan', {
                              age: formatAge(
                                  tAge,
                                  now === null ? null : ageParts(meta.scannedAt, now),
                              ),
                          })
                        : t('neverScanned')}
                    {' · '}
                    {t('ofCap', { count: discovered, cap: FLEET_CHECKOUTS_DISCOVERY_CAP })}
                </span>
            </div>
            {folders && folders.length > 0 ? (
                <ul className="space-y-0.5 font-mono text-xs">
                    {folders.map((folder) => (
                        <li key={folder} title={folder}>
                            {homeRelativePath(folder)}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {folders === null
                        ? t('unknown', { name: node.name })
                        : t('none', { name: node.name })}
                </p>
            )}
            {meta?.truncated ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                    {t('truncated', { cap: FLEET_CHECKOUTS_DISCOVERY_CAP, name: node.name })}
                </p>
            ) : null}
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('setOnMachine')}</p>
            <CopyCommand
                command={CODE_FOLDER_COMMAND}
                testId="fleet-checkouts-code-folder-command"
            />
        </div>
    );
}

function CheckoutRow({
    row,
    node,
    showComputer,
    pending,
    notice,
    confirming,
    now,
    onAction,
    onCancelConfirm,
    deleting,
    onDeleted,
    onCancelDelete,
}: {
    row: FleetCheckoutView;
    node: FleetNodeView | null;
    showComputer: boolean;
    pending: boolean;
    notice: RowNotice | null;
    /** The action waiting for its one confirmation (CONTRACTS §2.2 class `confirm`). */
    confirming: 'archive' | 'pull' | 'push' | null;
    now: number | null;
    onAction: (action: CheckoutRowAction) => void;
    onCancelConfirm: () => void;
    deleting: { mode: 'delete' | 'forget'; preview: CheckoutDeletePreview } | null;
    onDeleted: (result: { forgotten: boolean; checkout: FleetCheckoutView | null }) => void;
    onCancelDelete: () => void;
}) {
    const t = useTranslations('fleet.checkouts');
    const online = isComputerOnline(node);
    const context = { node };
    const dimmed = !online || row.state === 'missing';
    const size = formatCheckoutSize(row.sizeBytes);
    const actions = checkoutRowActions(row);
    const ago = (iso: string | null) => formatAge(t, now === null ? null : ageParts(iso, now));

    const activity = (() => {
        if (row.state === 'missing') return t('row.missing', { name: node?.name ?? '' });
        if (row.state === 'creating') return t('row.creating');
        if (row.state === 'archived')
            return row.folderRemoved
                ? t('row.folderRemoved')
                : t('row.archived', { age: ago(row.archivedAt) });
        if (row.busy === 'lease') return t('row.taskRunning');
        if (row.busy === 'session') return t('row.sessionRunning');
        if (!online) return t('row.lastKnown', { age: ago(row.lastSeenAt) });
        if (row.createdBy === 'discovery') return t('row.found', { age: ago(row.createdAt) });
        return t('row.seen', { age: ago(row.lastSeenAt) });
    })();

    return (
        <li
            className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm',
                dimmed && 'opacity-60',
            )}
            data-testid="fleet-checkout-row"
            data-state={row.state}
            data-kind={row.kind}
        >
            {showComputer ? (
                <span className="inline-flex min-w-[6rem] items-center gap-1 text-xs">
                    <span
                        aria-hidden
                        className={cn(
                            'h-2 w-2 rounded-full',
                            online ? 'bg-emerald-500' : 'bg-gray-400',
                        )}
                    />
                    {node?.name ?? t('row.unknownComputer')}
                </span>
            ) : null}
            <span className="min-w-[10rem] font-mono text-xs" title={row.path}>
                {homeRelativePath(row.path)}
            </span>
            <GitLine line={row.gitLine} branch={row.branch} />
            <span className="text-xs text-text-muted dark:text-text-muted-dark">{activity}</span>
            {size ? (
                <span className="text-xs text-text-muted dark:text-text-muted-dark">{size}</span>
            ) : null}
            {row.kind === 'worktree' && row.createdBy === 'task' ? (
                <span className="rounded bg-gray-100 px-1 text-xs dark:bg-gray-800">
                    {t('row.taskBadge')}
                </span>
            ) : null}
            {row.isolation === 'container' ? (
                <span className="rounded bg-blue-100 px-1 text-xs dark:bg-blue-900">
                    {t('row.containerBadge')}
                </span>
            ) : null}
            {row.remoteHadCredential ? (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                    {t('row.credentialStripped')}
                </span>
            ) : null}
            {row.reaperNote ? (
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('row.reaperNote', { note: row.reaperNote })}
                </span>
            ) : null}
            {/* FL-06 (spec FR-25, §5.7): Clean up a worktree whose pull request is merged or closed. */}
            {canCleanUp({
                kind: row.kind,
                state: row.state,
                pr: row.gitLine?.pr,
                sessionLive: row.busy === 'session',
            }) ? (
                <CleanUpButton
                    checkoutId={row.id}
                    branch={row.branch}
                    nodeName={node?.name ?? ''}
                />
            ) : null}
            <span className="ml-auto flex items-center gap-1">
                {confirming ? (
                    <>
                        <span className="text-xs">
                            {confirming === 'archive'
                                ? t('confirmArchive', { name: homeRelativePath(row.path) })
                                : t(confirming === 'pull' ? 'confirmPull' : 'confirmPush', {
                                      branch: row.branch ?? '—',
                                      remote: row.repository ?? 'origin',
                                      name: node?.name ?? '',
                                  })}
                        </span>
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => onAction(confirming)}
                            disabled={pending}
                            data-testid={`fleet-checkout-${confirming}-confirm`}
                        >
                            {t(
                                confirming === 'archive'
                                    ? 'actions.archiveConfirm'
                                    : confirming === 'pull'
                                      ? 'actions.pullConfirm'
                                      : 'actions.pushConfirm',
                            )}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={onCancelConfirm}>
                            {t('actions.cancel')}
                        </Button>
                    </>
                ) : (
                    actions.map((action) => {
                        const state = checkoutActionState(action, row, context);
                        const Icon = ACTION_ICONS[action];
                        return (
                            <Button
                                key={action}
                                size="sm"
                                variant={action === 'fetch' ? 'secondary' : 'ghost'}
                                disabled={pending || !state.enabled}
                                title={
                                    state.enabled
                                        ? undefined
                                        : t(`disabled.${state.reason}`, { name: node?.name ?? '' })
                                }
                                onClick={() => onAction(action)}
                                data-testid={`fleet-checkout-${action}`}
                            >
                                <Icon className="mr-1 h-3.5 w-3.5" aria-hidden />
                                {t(`actions.${action}`)}
                            </Button>
                        );
                    })
                )}
            </span>
            {deleting ? (
                <DeleteCheckoutDialog
                    row={row}
                    mode={deleting.mode}
                    preview={deleting.preview}
                    onDone={onDeleted}
                    onCancel={onCancelDelete}
                />
            ) : null}
            {notice ? (
                <p
                    role={notice.tone === 'error' ? 'alert' : 'status'}
                    className={cn(
                        'basis-full text-xs',
                        notice.tone === 'error'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-emerald-600',
                    )}
                >
                    {notice.text}
                </p>
            ) : null}
        </li>
    );
}
