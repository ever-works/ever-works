'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    Activity,
    AlertTriangle,
    Info,
    Laptop,
    Pause,
    Pencil,
    Play,
    Plus,
    Server,
    Boxes,
    Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import type {
    CreateFleetEnrollmentTokenResponse,
    FleetEnrollmentTokenView,
    FleetNodeDetailView,
    FleetNodeKind,
    FleetNodeView,
} from '@/lib/api/fleet';
import {
    createFleetEnrollmentTokenAction,
    deleteFleetNodeAction,
    drainFleetNodeAction,
    getFleetNodeDetailAction,
    listFleetEnrollmentTokensAction,
    revokeFleetEnrollmentTokenAction,
    rotateFleetNodeCredentialAction,
    updateFleetNodeAction,
} from '@/app/actions/settings/fleet';
import { FleetEnrollHandoff } from './FleetEnrollHandoff';
import { FleetNodeDrawer } from './FleetNodeDrawer';
import { FleetTokensSection } from './FleetTokensSection';

interface FleetSettingsProps {
    initialNodes: FleetNodeView[];
    loadError: string | null;
    /** Outstanding (minted, unused) enrollment tokens. */
    initialTokens: FleetEnrollmentTokenView[];
    tokensError: string | null;
    /** Public API base a node should call — used in the CLI one-liner + QR. */
    apiBaseUrl: string;
    desktopDownloadUrl: string;
    nodeDownloadUrl: string;
}

const ENROLLABLE_KINDS: Exclude<FleetNodeKind, 'k8s'>[] = ['desktop-node', 'node'];

function formatLastSeen(value: string | null): string {
    if (!value) return '-';
    try {
        return new Date(value).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return value;
    }
}

/**
 * Fleet — settings UI for the node registry:
 *   - Enrolled-nodes table (name, kind badge, status dot, platform,
 *     capability chips, last-seen) with details / rename / disable /
 *     remove (confirm) actions.
 *   - "Add node" flow issuing a ONE-TIME enrollment token, handed over
 *     without retyping: copy button, ready-to-run CLI command, a QR of
 *     that command, a downloadable handoff file, and links to the node
 *     app downloads.
 *   - Outstanding-token list with pre-use revoke, so a minted-but-never
 *     used credential is visible and killable.
 *   - Per-node detail drawer: job/failure history, admin-editable
 *     capability tags, credential rotation and drain.
 *   - Read-only section for live nodes of the user's OWN configured
 *     clusters (never the shared platform clusters, never persisted).
 */
export function FleetSettings({
    initialNodes,
    loadError,
    initialTokens,
    tokensError,
    apiBaseUrl,
    desktopDownloadUrl,
    nodeDownloadUrl,
}: FleetSettingsProps) {
    const t = useTranslations('dashboard.settings.fleet');
    const [nodes, setNodes] = useState<FleetNodeView[]>(initialNodes);
    const [isPending, startTransition] = useTransition();

    const enrolledNodes = useMemo(() => nodes.filter((node) => node.persisted), [nodes]);
    const clusterNodes = useMemo(
        () => nodes.filter((node) => !node.persisted && node.kind === 'k8s'),
        [nodes],
    );

    // "Add node" dialog: form phase, then the one-time-token phase. The
    // token phase is shared with credential rotation — both hand over a
    // one-time token that is shown exactly once.
    const [addOpen, setAddOpen] = useState(false);
    const [addName, setAddName] = useState('');
    const [addKind, setAddKind] = useState<Exclude<FleetNodeKind, 'k8s'>>('desktop-node');
    const [issued, setIssued] = useState<CreateFleetEnrollmentTokenResponse | null>(null);
    const [issuedFromRotation, setIssuedFromRotation] = useState(false);

    // Outstanding enrollment tokens.
    const [tokens, setTokens] = useState<FleetEnrollmentTokenView[]>(initialTokens);
    const [tokensLoading, setTokensLoading] = useState(false);
    const [tokensLoadError, setTokensLoadError] = useState<string | null>(tokensError);
    const [revokeTarget, setRevokeTarget] = useState<FleetEnrollmentTokenView | null>(null);

    // Node-detail drawer.
    const [drawerNode, setDrawerNode] = useState<FleetNodeView | null>(null);
    const [drawerDetail, setDrawerDetail] = useState<FleetNodeDetailView | null>(null);
    const [drawerLoading, setDrawerLoading] = useState(false);
    const [drawerError, setDrawerError] = useState<string | null>(null);

    // Rename dialog.
    const [renameTarget, setRenameTarget] = useState<FleetNodeView | null>(null);
    const [renameValue, setRenameValue] = useState('');

    // Remove confirm dialog.
    const [removeTarget, setRemoveTarget] = useState<FleetNodeView | null>(null);

    const kindLabel = (kind: FleetNodeKind): string => t(`kinds.${kind}` as never);

    const statusDotClass = (status: FleetNodeView['status']): string => {
        switch (status) {
            case 'online':
                return 'bg-success';
            case 'enrolling':
                return 'bg-warning';
            case 'disabled':
                return 'bg-danger';
            default:
                return 'bg-text-muted dark:bg-text-muted-dark';
        }
    };

    const refreshTokens = useCallback(() => {
        setTokensLoading(true);
        startTransition(async () => {
            const result = await listFleetEnrollmentTokensAction();
            setTokensLoading(false);
            if (result.success) {
                setTokens(result.data);
                setTokensLoadError(null);
            } else {
                setTokensLoadError(result.error);
            }
        });
    }, []);

    const closeAddDialog = () => {
        setAddOpen(false);
        // The token is shown exactly once — drop it with the dialog.
        setIssued(null);
        setIssuedFromRotation(false);
        setAddName('');
        setAddKind('desktop-node');
    };

    const handleIssueToken = () => {
        if (!addName.trim()) {
            toast.error(t('add.nameRequired'));
            return;
        }
        startTransition(async () => {
            const result = await createFleetEnrollmentTokenAction({
                name: addName.trim(),
                kind: addKind,
            });
            if (result.success) {
                setIssued(result.data);
                setIssuedFromRotation(false);
                setNodes((prev) => [...prev, result.data.node]);
                toast.success(t('add.issued'));
                refreshTokens();
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleRename = () => {
        if (!renameTarget || !renameValue.trim()) return;
        const target = renameTarget;
        startTransition(async () => {
            const result = await updateFleetNodeAction(target.id, { name: renameValue.trim() });
            if (result.success) {
                setNodes((prev) =>
                    prev.map((node) => (node.id === target.id ? result.data : node)),
                );
                setRenameTarget(null);
                toast.success(t('messages.renamed'));
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleToggleDisabled = (node: FleetNodeView) => {
        const disabled = node.status !== 'disabled';
        startTransition(async () => {
            const result = await updateFleetNodeAction(node.id, { disabled });
            if (result.success) {
                setNodes((prev) =>
                    prev.map((entry) => (entry.id === node.id ? result.data : entry)),
                );
                toast.success(disabled ? t('messages.disabled') : t('messages.enabled'));
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleRemove = () => {
        if (!removeTarget) return;
        const target = removeTarget;
        startTransition(async () => {
            const result = await deleteFleetNodeAction(target.id);
            if (result.success) {
                setNodes((prev) => prev.filter((node) => node.id !== target.id));
                setRemoveTarget(null);
                toast.success(t('messages.removed'));
                refreshTokens();
            } else {
                toast.error(result.error);
            }
        });
    };

    const openDrawer = (node: FleetNodeView) => {
        setDrawerNode(node);
        setDrawerDetail(null);
        setDrawerError(null);
        setDrawerLoading(true);
        startTransition(async () => {
            const result = await getFleetNodeDetailAction(node.id);
            setDrawerLoading(false);
            if (result.success) {
                setDrawerDetail(result.data);
                setNodes((prev) =>
                    prev.map((entry) => (entry.id === node.id ? result.data.node : entry)),
                );
                setDrawerNode(result.data.node);
            } else {
                setDrawerError(result.error);
            }
        });
    };

    const handleSaveCapabilities = (capabilities: string[], pinned: boolean) => {
        const target = drawerNode;
        if (!target) return;
        startTransition(async () => {
            const result = await updateFleetNodeAction(target.id, {
                capabilities,
                capabilitiesPinned: pinned,
            });
            if (result.success) {
                setNodes((prev) =>
                    prev.map((entry) => (entry.id === target.id ? result.data : entry)),
                );
                setDrawerNode(result.data);
                setDrawerDetail((prev) => (prev ? { ...prev, node: result.data } : prev));
                toast.success(t('capabilities.saved'));
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleRotate = () => {
        const target = drawerNode;
        if (!target) return;
        startTransition(async () => {
            const result = await rotateFleetNodeCredentialAction(target.id);
            if (result.success) {
                setNodes((prev) =>
                    prev.map((entry) => (entry.id === target.id ? result.data.node : entry)),
                );
                // Close the drawer and surface the replacement token —
                // it is returned exactly once, so it must not be behind
                // anything the operator has to go looking for.
                setDrawerNode(null);
                setDrawerDetail(null);
                setIssued(result.data);
                setIssuedFromRotation(true);
                setAddOpen(true);
                toast.success(t('controls.rotated'));
                refreshTokens();
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleDrain = (drain: boolean) => {
        const target = drawerNode;
        if (!target) return;
        startTransition(async () => {
            const result = await drainFleetNodeAction(target.id, drain);
            if (result.success) {
                setNodes((prev) =>
                    prev.map((entry) => (entry.id === target.id ? result.data.node : entry)),
                );
                setDrawerNode(result.data.node);
                setDrawerDetail((prev) => (prev ? { ...prev, node: result.data.node } : prev));
                toast.success(
                    drain
                        ? t('controls.drained', { count: result.data.releasedJobs })
                        : t('controls.undrained'),
                );
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleRevokeToken = () => {
        if (!revokeTarget) return;
        const target = revokeTarget;
        startTransition(async () => {
            const result = await revokeFleetEnrollmentTokenAction(target.nodeId);
            if (result.success) {
                setTokens((prev) => prev.filter((token) => token.nodeId !== target.nodeId));
                setNodes((prev) => prev.filter((node) => node.id !== target.nodeId));
                setRevokeTarget(null);
                toast.success(t('tokens.revoked'));
            } else {
                toast.error(result.error);
            }
        });
    };

    return (
        <div className="space-y-8" data-testid="fleet-settings">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                        {t('title')}
                    </h2>
                    <p className="text-text-muted dark:text-text-muted-dark text-sm">
                        {t('subtitle')}
                    </p>
                </div>
                <Button onClick={() => setAddOpen(true)} data-testid="fleet-add-node">
                    <Plus className="w-4 h-4" />
                    {t('add.button')}
                </Button>
            </div>

            {loadError && (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">{loadError}</p>
                </div>
            )}

            {enrolledNodes.length === 0 ? (
                <div
                    className="p-8 rounded-lg border border-dashed border-border dark:border-border-dark text-center space-y-2"
                    data-testid="fleet-empty-state"
                >
                    <Server className="w-8 h-8 mx-auto text-text-muted dark:text-text-muted-dark" />
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('empty.title')}
                    </p>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-lg mx-auto">
                        {t('empty.description')}
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border dark:border-border-dark">
                    <table className="w-full text-sm" data-testid="fleet-nodes-table">
                        <thead>
                            <tr className="border-b border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-left">
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.name')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.kind')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.status')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.platform')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.load')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.capabilities')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.lastSeen')}
                                </th>
                                <th className="px-4 py-2.5" />
                            </tr>
                        </thead>
                        <tbody>
                            {enrolledNodes.map((node) => (
                                <tr
                                    key={node.id}
                                    className="border-b last:border-b-0 border-border dark:border-border-dark"
                                    data-testid={`fleet-node-row-${node.id}`}
                                >
                                    <td className="px-4 py-3 font-medium text-text dark:text-text-dark">
                                        {node.name}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark">
                                            {node.kind === 'desktop-node' ? (
                                                <Laptop className="w-3 h-3" />
                                            ) : (
                                                <Server className="w-3 h-3" />
                                            )}
                                            {kindLabel(node.kind)}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3">
                                        <span
                                            className="inline-flex items-center gap-1.5 text-xs font-medium text-text dark:text-text-dark"
                                            data-testid={`fleet-node-status-${node.id}`}
                                        >
                                            <span
                                                className={`w-1.5 h-1.5 rounded-full ${statusDotClass(node.status)}`}
                                            />
                                            {t(`statuses.${node.status}` as never)}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark">
                                        {node.platform ?? '-'}
                                    </td>
                                    <td className="px-4 py-3">
                                        {(() => {
                                            const activeJobs = node.load?.activeJobCount ?? 0;
                                            return (
                                                <span
                                                    className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                                                        activeJobs > 0
                                                            ? 'text-info'
                                                            : 'text-text-muted dark:text-text-muted-dark'
                                                    }`}
                                                    data-testid={`fleet-node-load-${node.id}`}
                                                    title={
                                                        node.load?.currentJobKind
                                                            ? t('load.currentJob', {
                                                                  kind: node.load.currentJobKind,
                                                              })
                                                            : undefined
                                                    }
                                                >
                                                    {activeJobs > 0 ? (
                                                        <>
                                                            <Activity className="w-3 h-3" />
                                                            {t('load.busy', { count: activeJobs })}
                                                        </>
                                                    ) : (
                                                        t('load.idle')
                                                    )}
                                                </span>
                                            );
                                        })()}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex flex-wrap gap-1">
                                            {node.capabilities.length === 0 ? (
                                                <span className="text-text-muted dark:text-text-muted-dark">
                                                    -
                                                </span>
                                            ) : (
                                                node.capabilities.map((capability) => (
                                                    <span
                                                        key={capability}
                                                        className="px-1.5 py-0.5 rounded text-xs bg-info/10 text-info"
                                                    >
                                                        {capability}
                                                    </span>
                                                ))
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                        {formatLastSeen(node.lastHeartbeatAt)}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center justify-end gap-1">
                                            <Button
                                                variant="ghost"
                                                onClick={() => openDrawer(node)}
                                                disabled={isPending}
                                                data-testid={`fleet-node-details-${node.id}`}
                                                title={t('actions.details')}
                                            >
                                                <Info className="w-4 h-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                onClick={() => {
                                                    setRenameTarget(node);
                                                    setRenameValue(node.name);
                                                }}
                                                disabled={isPending}
                                                data-testid={`fleet-node-rename-${node.id}`}
                                                title={t('actions.rename')}
                                            >
                                                <Pencil className="w-4 h-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                onClick={() => handleToggleDisabled(node)}
                                                disabled={isPending}
                                                data-testid={`fleet-node-disable-${node.id}`}
                                                title={
                                                    node.status === 'disabled'
                                                        ? t('actions.enable')
                                                        : t('actions.disable')
                                                }
                                            >
                                                {node.status === 'disabled' ? (
                                                    <Play className="w-4 h-4" />
                                                ) : (
                                                    <Pause className="w-4 h-4" />
                                                )}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                onClick={() => setRemoveTarget(node)}
                                                disabled={isPending}
                                                data-testid={`fleet-node-remove-${node.id}`}
                                                title={t('actions.remove')}
                                            >
                                                <Trash2 className="w-4 h-4 text-danger" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <FleetTokensSection
                tokens={tokens}
                loading={tokensLoading}
                error={tokensLoadError}
                isPending={isPending}
                onRefresh={refreshTokens}
                onRevoke={setRevokeTarget}
            />

            <div className="space-y-3" data-testid="fleet-cluster-section">
                <div className="flex items-center gap-2">
                    <Boxes className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('cluster.title')}
                    </h3>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('cluster.description')}
                </p>
                {clusterNodes.length === 0 ? (
                    <p
                        className="text-sm text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-cluster-empty"
                    >
                        {t('cluster.empty')}
                    </p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-border dark:border-border-dark">
                        <table className="w-full text-sm" data-testid="fleet-cluster-table">
                            <thead>
                                <tr className="border-b border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-left">
                                    <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                        {t('table.name')}
                                    </th>
                                    <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                        {t('table.status')}
                                    </th>
                                    <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                        {t('table.platform')}
                                    </th>
                                    <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                        {t('cluster.roles')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {clusterNodes.map((node) => (
                                    <tr
                                        key={node.id}
                                        className="border-b last:border-b-0 border-border dark:border-border-dark"
                                    >
                                        <td className="px-4 py-3 font-medium text-text dark:text-text-dark">
                                            {node.name}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text dark:text-text-dark">
                                                <span
                                                    className={`w-1.5 h-1.5 rounded-full ${statusDotClass(node.status)}`}
                                                />
                                                {t(`statuses.${node.status}` as never)}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark">
                                            {node.platform ?? '-'}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex flex-wrap gap-1">
                                                {node.capabilities.length === 0 ? (
                                                    <span className="text-text-muted dark:text-text-muted-dark">
                                                        -
                                                    </span>
                                                ) : (
                                                    node.capabilities.map((role) => (
                                                        <span
                                                            key={role}
                                                            className="px-1.5 py-0.5 rounded text-xs bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark"
                                                        >
                                                            {role}
                                                        </span>
                                                    ))
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Add node — form phase, then the one-time-token handoff. */}
            <Dialog
                open={addOpen}
                onOpenChange={(open) => (open ? setAddOpen(true) : closeAddDialog())}
            >
                <DialogContent className="max-w-2xl">
                    <DialogClose onClose={closeAddDialog} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {issuedFromRotation ? t('controls.rotatedTitle') : t('add.title')}
                        </DialogTitle>
                    </DialogHeader>
                    {!issued ? (
                        <div className="space-y-4">
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('add.description')}
                            </p>
                            <div>
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('add.nameLabel')}
                                </label>
                                <Input
                                    value={addName}
                                    onChange={(event) => setAddName(event.target.value)}
                                    maxLength={200}
                                    placeholder={t('add.namePlaceholder')}
                                    data-testid="fleet-add-name"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-1.5">
                                    {t('add.kindLabel')}
                                </label>
                                <Select
                                    value={addKind}
                                    onValueChange={(value) =>
                                        setAddKind(value as Exclude<FleetNodeKind, 'k8s'>)
                                    }
                                    data-testid="fleet-add-kind"
                                >
                                    {ENROLLABLE_KINDS.map((kind) => (
                                        <option key={kind} value={kind}>
                                            {kindLabel(kind)}
                                        </option>
                                    ))}
                                </Select>
                                <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                                    {t(`add.kindHelper.${addKind}` as never)}
                                </p>
                            </div>
                            <DialogFooter>
                                <Button variant="secondary" onClick={closeAddDialog}>
                                    {t('add.cancel')}
                                </Button>
                                <Button
                                    onClick={handleIssueToken}
                                    loading={isPending}
                                    data-testid="fleet-add-submit"
                                >
                                    {t('add.submit')}
                                </Button>
                            </DialogFooter>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <FleetEnrollHandoff
                                issued={issued}
                                apiBaseUrl={apiBaseUrl}
                                desktopDownloadUrl={desktopDownloadUrl}
                                nodeDownloadUrl={nodeDownloadUrl}
                            />
                            <DialogFooter>
                                <Button onClick={closeAddDialog} data-testid="fleet-add-done">
                                    {t('add.done')}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Node detail */}
            <FleetNodeDrawer
                node={drawerNode}
                detail={drawerDetail}
                loading={drawerLoading}
                error={drawerError}
                isPending={isPending}
                onClose={() => {
                    setDrawerNode(null);
                    setDrawerDetail(null);
                    setDrawerError(null);
                }}
                onSaveCapabilities={handleSaveCapabilities}
                onRotate={handleRotate}
                onDrain={handleDrain}
            />

            {/* Rename */}
            <Dialog
                open={renameTarget !== null}
                onOpenChange={(open) => !open && setRenameTarget(null)}
            >
                <DialogContent>
                    <DialogClose onClose={() => setRenameTarget(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('rename.title')}
                        </DialogTitle>
                    </DialogHeader>
                    <Input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        maxLength={200}
                        data-testid="fleet-rename-input"
                    />
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setRenameTarget(null)}>
                            {t('rename.cancel')}
                        </Button>
                        <Button
                            onClick={handleRename}
                            loading={isPending}
                            data-testid="fleet-rename-confirm"
                        >
                            {t('rename.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Revoke an outstanding token (confirm) */}
            <Dialog
                open={revokeTarget !== null}
                onOpenChange={(open) => !open && setRevokeTarget(null)}
            >
                <DialogContent>
                    <DialogClose onClose={() => setRevokeTarget(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('tokens.revokeTitle')}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('tokens.revokeDescription', { name: revokeTarget?.name ?? '' })}
                    </p>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setRevokeTarget(null)}>
                            {t('tokens.revokeCancel')}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={handleRevokeToken}
                            loading={isPending}
                            data-testid="fleet-token-revoke-confirm"
                        >
                            {t('tokens.revoke')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Remove (confirm) */}
            <Dialog
                open={removeTarget !== null}
                onOpenChange={(open) => !open && setRemoveTarget(null)}
            >
                <DialogContent>
                    <DialogClose onClose={() => setRemoveTarget(null)} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('remove.title')}
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('remove.description', { name: removeTarget?.name ?? '' })}
                    </p>
                    <DialogFooter>
                        <Button variant="secondary" onClick={() => setRemoveTarget(null)}>
                            {t('remove.cancel')}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={handleRemove}
                            loading={isPending}
                            data-testid="fleet-remove-confirm"
                        >
                            {t('remove.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
