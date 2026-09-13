'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { NodeAgentProfileView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { formatBytes } from '@/components/dashboard/runner-status.shared';
import { browserApiFetch } from '@/lib/api/browser-api';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agentId: string;
    agentName: string;
    nodeId: string;
    nodeName: string;
    profile: NodeAgentProfileView | null;
    /** Seam for tests. */
    fetchImpl?: typeof fetch;
}

type ResetOutcome = 'idle' | 'working' | 'done' | 'blocked' | 'mismatch' | 'failed';

/**
 * Own logins and files — the Agent's own browser profile on this computer:
 * the isolation guarantee in words, what the profile holds, and a reset that
 * needs the Agent's name typed to confirm, touches no other Agent, and is
 * refused while this Agent is working on this computer.
 */
export function ComputerProfilePanel({
    open,
    onOpenChange,
    agentId,
    agentName,
    nodeId,
    nodeName,
    profile,
    fetchImpl,
}: Props) {
    const t = useTranslations('dashboard.computer.profile');
    const [view, setView] = useState<NodeAgentProfileView | null>(profile);
    const [confirming, setConfirming] = useState(false);
    const [typed, setTyped] = useState('');
    const [outcome, setOutcome] = useState<ResetOutcome>('idle');

    const reset = async () => {
        setOutcome('working');
        try {
            const res = await (fetchImpl ?? browserApiFetch)(
                `/api/agents/${agentId}/computer/profile/reset`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nodeId, confirmAgentName: typed }),
                },
            );
            if (res.ok) {
                setView((await res.json().catch(() => null)) as NodeAgentProfileView | null);
                setOutcome('done');
                setConfirming(false);
                setTyped('');
                return;
            }
            setOutcome(res.status === 409 ? 'blocked' : res.status === 422 ? 'mismatch' : 'failed');
        } catch {
            setOutcome('failed');
        }
    };

    const nameMatches = typed.trim() === agentName.trim();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </DialogTitle>
                    <DialogDescription>
                        {view
                            ? t('body', { agent: agentName, node: nodeName })
                            : t('notYet', { agent: agentName, node: nodeName })}
                    </DialogDescription>
                </DialogHeader>

                {view ? (
                    <dl
                        data-testid="computer-profile-facts"
                        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm"
                    >
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('created')}
                        </dt>
                        <dd>{view.createdAt ? <ShowDateTime value={view.createdAt} /> : '—'}</dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('lastUsed')}
                        </dt>
                        <dd>{view.lastUsedAt ? <ShowDateTime value={view.lastUsedAt} /> : '—'}</dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('signedInTo')}
                        </dt>
                        <dd>{t('signedInCount', { count: view.signedInSiteCount })}</dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('diskUsed')}
                        </dt>
                        <dd>{formatBytes(view.diskBytes) ?? '—'}</dd>
                        <dt className="text-text-muted dark:text-text-muted-dark">
                            {t('lastReset')}
                        </dt>
                        <dd>
                            {view.lastResetAt ? (
                                <ShowDateTime value={view.lastResetAt} />
                            ) : (
                                t('never')
                            )}
                        </dd>
                    </dl>
                ) : null}

                {outcome === 'done' ? (
                    <p role="status" className="mt-3 text-sm text-success">
                        {t('resetDone', { agent: agentName, node: nodeName })}
                    </p>
                ) : null}

                {view && confirming ? (
                    <div className="mt-4 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm">
                        <p className="font-medium">
                            {t('resetTitle', { agent: agentName, node: nodeName })}
                        </p>
                        <p className="mt-1 text-text-secondary dark:text-text-secondary-dark">
                            {t('resetBody', {
                                agent: agentName,
                                node: nodeName,
                                count: view.signedInSiteCount,
                            })}
                        </p>
                        <label className="mt-3 block text-xs" htmlFor="computer-profile-confirm">
                            {t('resetConfirmLabel')}
                        </label>
                        <input
                            id="computer-profile-confirm"
                            data-testid="computer-profile-confirm"
                            value={typed}
                            onChange={(event) => setTyped(event.target.value)}
                            autoComplete="off"
                            className="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-sm dark:border-border-dark dark:bg-surface-dark"
                        />
                        {outcome === 'blocked' ? (
                            <p role="alert" className="mt-2 text-danger">
                                {t('resetBlocked', { agent: agentName })}
                            </p>
                        ) : null}
                        {outcome === 'mismatch' ? (
                            <p role="alert" className="mt-2 text-danger">
                                {t('resetMismatch')}
                            </p>
                        ) : null}
                        {outcome === 'failed' ? (
                            <p role="alert" className="mt-2 text-danger">
                                {t('resetFailed')}
                            </p>
                        ) : null}
                        <div className="mt-3 flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                                {t('cancel')}
                            </Button>
                            <Button
                                variant="danger"
                                size="sm"
                                disabled={!nameMatches || outcome === 'working'}
                                onClick={() => void reset()}
                            >
                                {t('resetConfirm')}
                            </Button>
                        </div>
                    </div>
                ) : null}

                <DialogFooter>
                    {view && !confirming ? (
                        <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                            {t('resetAction')}
                        </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t('close')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
