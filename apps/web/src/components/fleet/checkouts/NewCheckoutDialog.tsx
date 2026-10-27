'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
    FleetCheckoutCreateRequest,
    FleetCheckoutView,
    FleetNodeView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { createCheckoutAction } from '@/app/actions/fleet-checkouts';
import { formatCheckoutSize, homeRelativePath, isComputerOnline } from './checkouts.shared';

/**
 * Checkouts on computers (FL-14 P2, spec §5.3, S3, S4) — New checkout: Where
 * (a computer; offline or not `--manage` rows say why) → What and How (a fresh
 * clone of a repository URL, or a worktree of a checkout on that computer) →
 * Branch (optional; the platform proposes one and makes it unique) → Create.
 * The footer always states the cost: disk on that computer, no tokens or
 * credits. The row appears as `creating` at once; the panel's poll settles it.
 */
export function NewCheckoutDialog({
    nodes,
    rows,
    onCreated,
    onClose,
}: {
    nodes: FleetNodeView[];
    rows: FleetCheckoutView[];
    onCreated: (checkout: FleetCheckoutView) => void;
    onClose: () => void;
}) {
    const t = useTranslations('fleet.checkouts.newDialog');
    const usable = nodes.filter((node) => isComputerOnline(node) && node.consents?.manage === true);
    const [nodeId, setNodeId] = useState<string>(usable[0]?.id ?? '');
    const [how, setHow] = useState<'clone' | 'worktree'>('clone');
    const [repoUrl, setRepoUrl] = useState('');
    const [parentId, setParentId] = useState('');
    const [branch, setBranch] = useState('');
    const [container, setContainer] = useState(false);
    const [shared, setShared] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const node = nodes.find((candidate) => candidate.id === nodeId) ?? null;
    const parents = rows.filter(
        (row) =>
            row.nodeId === nodeId &&
            row.state === 'ready' &&
            row.createdBy !== 'task' &&
            row.remoteUrl,
    );
    const parent = parents.find((row) => row.id === parentId) ?? null;
    const size = formatCheckoutSize(parent?.sizeBytes ?? null);
    const ready = Boolean(node) && (how === 'clone' ? repoUrl.trim().length > 0 : Boolean(parent));
    // Spec U11: container isolation needs Docker and is not offered on Windows.
    const tags = node?.capabilities ?? [];
    const containerReason = tags.includes('os:win32')
        ? t('containerWindows')
        : !tags.includes('docker')
          ? t('containerNoDocker', { name: node?.name ?? '' })
          : null;

    const submit = async () => {
        if (!ready || !node) return;
        setBusy(true);
        setError(null);
        const request: FleetCheckoutCreateRequest = {
            nodeId: node.id,
            source:
                how === 'clone'
                    ? { kind: 'clone', repoUrl: repoUrl.trim() }
                    : { kind: 'worktree', parentCheckoutId: parentId },
        };
        if (branch.trim()) request.branch = branch.trim();
        if (container && !containerReason) request.isolation = 'container';
        const folders = shared
            .split(',')
            .map((folder) => folder.trim())
            .filter((folder) => folder.length > 0);
        if (how === 'worktree' && folders.length > 0) request.sharedFolders = folders;
        const result = await createCheckoutAction(request);
        setBusy(false);
        if (result.success) {
            onCreated(result.data.checkout);
            onClose();
        } else {
            setError(result.hint ?? t('failed'));
        }
    };

    return (
        <div
            role="dialog"
            aria-label={t('title')}
            className="space-y-3 rounded-lg border border-border p-4 text-sm dark:border-border-dark"
            data-testid="fleet-new-checkout"
        >
            <h3 className="font-medium">{t('title')}</h3>
            <label className="flex flex-col gap-1">
                <span className="text-xs">{t('where')}</span>
                <select
                    className="rounded border border-border bg-transparent px-2 py-1 dark:border-border-dark"
                    value={nodeId}
                    onChange={(event) => {
                        setNodeId(event.target.value);
                        setParentId('');
                    }}
                    data-testid="fleet-new-checkout-node"
                >
                    {nodes.map((candidate) => {
                        const online = isComputerOnline(candidate);
                        const managed = candidate.consents?.manage === true;
                        return (
                            <option
                                key={candidate.id}
                                value={candidate.id}
                                disabled={!online || !managed}
                            >
                                {candidate.name}
                                {!online
                                    ? ` — ${t('offline')}`
                                    : !managed
                                      ? ` — ${t('needsManage')}`
                                      : ''}
                            </option>
                        );
                    })}
                </select>
            </label>
            <fieldset className="flex flex-wrap gap-4">
                <legend className="mb-1 text-xs">{t('how')}</legend>
                <label className="inline-flex items-center gap-1">
                    <input
                        type="radio"
                        name="how"
                        checked={how === 'clone'}
                        onChange={() => setHow('clone')}
                    />
                    {t('clone')}
                </label>
                <label className="inline-flex items-center gap-1">
                    <input
                        type="radio"
                        name="how"
                        checked={how === 'worktree'}
                        onChange={() => setHow('worktree')}
                        disabled={parents.length === 0}
                    />
                    {t('worktree')}
                </label>
            </fieldset>
            {how === 'clone' ? (
                <label className="flex flex-col gap-1">
                    <span className="text-xs">{t('repoUrl')}</span>
                    <input
                        className="rounded border border-border bg-transparent px-2 py-1 font-mono text-xs dark:border-border-dark"
                        value={repoUrl}
                        onChange={(event) => setRepoUrl(event.target.value)}
                        placeholder="https://github.com/acme/api.git"
                        data-testid="fleet-new-checkout-repo"
                    />
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('credentialNote')}
                    </span>
                </label>
            ) : (
                <label className="flex flex-col gap-1">
                    <span className="text-xs">{t('parent')}</span>
                    <select
                        className="rounded border border-border bg-transparent px-2 py-1 font-mono text-xs dark:border-border-dark"
                        value={parentId}
                        onChange={(event) => setParentId(event.target.value)}
                        data-testid="fleet-new-checkout-parent"
                    >
                        <option value="">{t('chooseParent')}</option>
                        {parents.map((row) => (
                            <option key={row.id} value={row.id}>
                                {homeRelativePath(row.path)} ({row.branch ?? '—'})
                            </option>
                        ))}
                    </select>
                </label>
            )}
            <label className="flex flex-col gap-1">
                <span className="text-xs">{t('branch')}</span>
                <input
                    className="rounded border border-border bg-transparent px-2 py-1 font-mono text-xs dark:border-border-dark"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    placeholder={t('branchPlaceholder')}
                    data-testid="fleet-new-checkout-branch"
                />
                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('branchNote')}
                </span>
            </label>
            {how === 'worktree' ? (
                <label className="flex flex-col gap-1">
                    <span className="text-xs">{t('sharedFolders')}</span>
                    <input
                        className="rounded border border-border bg-transparent px-2 py-1 font-mono text-xs dark:border-border-dark"
                        value={shared}
                        onChange={(event) => setShared(event.target.value)}
                        placeholder="node_modules, .env.local"
                        data-testid="fleet-new-checkout-shared"
                    />
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('sharedFoldersNote')}
                    </span>
                </label>
            ) : null}
            <label className="inline-flex items-center gap-2" title={containerReason ?? undefined}>
                <input
                    type="checkbox"
                    checked={container && !containerReason}
                    disabled={containerReason !== null}
                    onChange={(event) => setContainer(event.target.checked)}
                    data-testid="fleet-new-checkout-container"
                />
                <span>{t('container')}</span>
                {containerReason ? (
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {containerReason}
                    </span>
                ) : null}
            </label>
            {error ? (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                    {error}
                </p>
            ) : null}
            <p
                className="text-xs text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-new-checkout-cost"
            >
                {size
                    ? t('costWithSize', { name: node?.name ?? '', size })
                    : t('cost', { name: node?.name ?? '' })}
            </p>
            <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onClose}>
                    {t('cancel')}
                </Button>
                <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void submit()}
                    disabled={!ready || busy}
                    data-testid="fleet-new-checkout-create"
                >
                    {busy ? t('creating') : t('create')}
                </Button>
            </div>
        </div>
    );
}
