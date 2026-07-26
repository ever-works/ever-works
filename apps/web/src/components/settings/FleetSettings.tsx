'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    Activity,
    AlertTriangle,
    Copy,
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
    FleetNodeKind,
    FleetNodeView,
} from '@/lib/api/fleet';
import {
    createFleetEnrollmentTokenAction,
    deleteFleetNodeAction,
    updateFleetNodeAction,
} from '@/app/actions/settings/fleet';

interface FleetSettingsProps {
    initialNodes: FleetNodeView[];
    loadError: string | null;
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
 * Fleet (Wave 12, slice 1) — settings UI for the node registry:
 *   - Enrolled-nodes table (name, kind badge, status dot, platform,
 *     capability chips, last-seen) with rename / disable / remove
 *     (confirm) actions.
 *   - "Add node" flow issuing a ONE-TIME enrollment token (copy
 *     button + short install-instructions placeholder — the node apps
 *     themselves are the next slice).
 *   - Read-only section for live nodes of the user's OWN configured
 *     clusters (never the shared platform clusters, never persisted).
 */
export function FleetSettings({ initialNodes, loadError }: FleetSettingsProps) {
    const t = useTranslations('dashboard.settings.fleet');
    const [nodes, setNodes] = useState<FleetNodeView[]>(initialNodes);
    const [isPending, startTransition] = useTransition();

    const enrolledNodes = useMemo(() => nodes.filter((node) => node.persisted), [nodes]);
    const clusterNodes = useMemo(
        () => nodes.filter((node) => !node.persisted && node.kind === 'k8s'),
        [nodes],
    );

    // "Add node" dialog: form phase, then the one-time-token phase.
    const [addOpen, setAddOpen] = useState(false);
    const [addName, setAddName] = useState('');
    const [addKind, setAddKind] = useState<Exclude<FleetNodeKind, 'k8s'>>('desktop-node');
    const [issued, setIssued] = useState<CreateFleetEnrollmentTokenResponse | null>(null);
    const [copied, setCopied] = useState(false);

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

    const closeAddDialog = () => {
        setAddOpen(false);
        // The token is shown exactly once — drop it with the dialog.
        setIssued(null);
        setAddName('');
        setAddKind('desktop-node');
        setCopied(false);
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
                setNodes((prev) => [...prev, result.data.node]);
                toast.success(t('add.issued'));
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleCopyToken = async () => {
        if (!issued) return;
        try {
            await navigator.clipboard.writeText(issued.token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error(t('add.copyError'));
        }
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

            {/* Add node — form phase, then one-time-token phase. */}
            <Dialog
                open={addOpen}
                onOpenChange={(open) => (open ? setAddOpen(true) : closeAddDialog())}
            >
                <DialogContent>
                    <DialogClose onClose={closeAddDialog} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('add.title')}
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
                            <p className="text-sm text-text dark:text-text-dark">
                                {t('add.tokenIntro', {
                                    minutes: Math.round(issued.expiresInSec / 60),
                                })}
                            </p>
                            <div className="flex items-center gap-2">
                                <code
                                    className="flex-1 px-3 py-2 rounded-lg border border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-sm break-all select-all"
                                    data-testid="fleet-enroll-token"
                                >
                                    {issued.token}
                                </code>
                                <Button
                                    variant="secondary"
                                    onClick={handleCopyToken}
                                    data-testid="fleet-copy-token"
                                >
                                    <Copy className="w-4 h-4" />
                                    {copied ? t('add.copied') : t('add.copy')}
                                </Button>
                            </div>
                            <div className="p-3 rounded-lg bg-info/10 border border-info/20 space-y-1">
                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                    {t('add.instructionsTitle')}
                                </p>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('add.instructionsBody')}
                                </p>
                            </div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('add.tokenOnce')}
                            </p>
                            <DialogFooter>
                                <Button onClick={closeAddDialog} data-testid="fleet-add-done">
                                    {t('add.done')}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

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
