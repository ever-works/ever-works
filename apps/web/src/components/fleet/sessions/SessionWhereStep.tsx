'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    FLEET_CHECKOUT_REF_MAX_LENGTH,
    isFleetCheckoutBranchName,
    type FleetCheckoutView,
    type FleetSessionBranchProposal,
    type FleetSessionKind,
} from '@ever-works/contracts';
import { listNodeCheckoutsAction } from '@/app/actions/fleet-checkouts';
import { getSessionBranchProposalAction } from '@/app/actions/fleet-session-git';
import { cn } from '@/lib/utils/cn';

/** Where a new session runs (spec FR-2, §5.6). */
export type SessionWhereChoice =
    | { mode: 'folder' }
    | { mode: 'existing'; checkoutId: string; path: string }
    | { mode: 'worktree'; parentCheckoutId: string; branch: string }
    | { mode: 'clone'; repoUrl: string; branch: string };

export type SessionWhereMode = 'existing' | 'worktree' | 'clone';

/**
 * The default Where mode for a checkout (spec FR-2): an Agent session starts
 * in a NEW worktree (two agents in one working tree overwrite each other), an
 * owner session in the checkout itself. A worktree needs a ready, host-
 * isolated checkout with a remote; a Task-pool worktree is used as it is.
 */
export function defaultWhereMode(kind: FleetSessionKind, checkout: Pick<FleetCheckoutView, 'createdBy' | 'remoteUrl'>): SessionWhereMode {
    if (kind === 'agent' && checkout.createdBy !== 'task' && checkout.remoteUrl) return 'worktree';
    return 'existing';
}

/** Debounce for asking the branch proposal while the first message is typed. */
const PROPOSAL_DEBOUNCE_MS = 600;

/**
 * Session git & actions (FL-06, spec FR-2 … FR-5, S1, U9, §5.6) — the start
 * dialog's Where step additions to FL-04: pick one of the computer's
 * checkouts, then **Existing checkout** · **New worktree** · **Fresh clone**
 * (New worktree preselected for an Agent session), and the branch field
 * proposing `<prefix>/<slug>` with why ("never used before on acme/api", or
 * "nina/fix-login exists — using nina/fix-login-2"). A branch the person
 * edits is theirs (it is still checked when the worktree is created). A
 * session from a Task shows the Task's own branch, read-only (FR-4).
 *
 * Without a checkout the step is FL-04's folder field, unchanged.
 */
export function SessionWhereStep({
    nodeId,
    nodeName,
    kind,
    agentId,
    firstMessage,
    title,
    taskId,
    cwd,
    onCwdChange,
    onChange,
}: {
    nodeId: string;
    nodeName: string;
    kind: FleetSessionKind;
    agentId: string | null;
    firstMessage: string;
    title: string;
    taskId?: string | null;
    /** FL-04's folder field: picking a checkout fills it; typing a checkout's path picks it. */
    cwd: string;
    onCwdChange: (cwd: string) => void;
    onChange: (choice: SessionWhereChoice) => void;
}) {
    const t = useTranslations('fleet.sessionGit.where');
    const tBranch = useTranslations('fleet.sessionGit.branch');
    const [checkouts, setCheckouts] = useState<FleetCheckoutView[]>([]);
    const [checkoutId, setCheckoutId] = useState<string>('');
    const [mode, setMode] = useState<SessionWhereMode>('existing');
    const [branch, setBranch] = useState('');
    const [edited, setEdited] = useState(false);
    const editedRef = useRef(false);
    editedRef.current = edited;
    const [proposal, setProposal] = useState<FleetSessionBranchProposal | null>(null);
    const [proposing, setProposing] = useState(false);
    const [proposalError, setProposalError] = useState<string | null>(null);
    const timer = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        void listNodeCheckoutsAction(nodeId, { state: 'ready' }).then((result) => {
            if (cancelled || !result.success) return;
            setCheckouts(result.data.data.filter((row) => row.state === 'ready' && row.isolation === 'host'));
        });
        return () => {
            cancelled = true;
        };
    }, [nodeId]);

    // Typing (or a recent-folder chip) that lands on a checkout's path picks that checkout.
    useEffect(() => {
        const match = checkouts.find((row) => row.path === cwd.trim());
        if (match && match.id !== checkoutId) {
            setCheckoutId(match.id);
            setMode(defaultWhereMode(kind, match));
        }
    }, [cwd, checkouts, checkoutId, kind]);

    const checkout = useMemo(() => checkouts.find((row) => row.id === checkoutId) ?? null, [checkouts, checkoutId]);

    useEffect(() => {
        if (checkout) setMode((current) => (current === 'existing' && kind === 'agent' ? defaultWhereMode(kind, checkout) : current));
    }, [kind, checkout]);

    // The branch proposal, asked again (debounced) while the first message or the title changes.
    useEffect(() => {
        if (!checkout || mode === 'existing') return;
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
            setProposing(true);
            void getSessionBranchProposalAction({
                nodeId,
                checkoutId: checkout.id,
                ...(kind === 'agent' && agentId ? { agentId } : {}),
                ...(firstMessage.trim() ? { firstMessage: firstMessage.trim() } : {}),
                ...(title.trim() ? { title: title.trim() } : {}),
                ...(taskId ? { taskId } : {}),
            }).then((result) => {
                setProposing(false);
                if (!result.success) {
                    setProposalError(result.hint ?? tBranch('failed'));
                    return;
                }
                setProposalError(null);
                setProposal(result.data);
                // A branch the person typed is theirs; a Task's branch is never theirs to change (FR-4).
                if (!editedRef.current || result.data.source === 'task') setBranch(result.data.branch);
                if (result.data.source === 'task') setEdited(false);
            });
        }, PROPOSAL_DEBOUNCE_MS);
        return () => {
            if (timer.current) window.clearTimeout(timer.current);
        };
    }, [checkout, mode, nodeId, kind, agentId, firstMessage, title, taskId, tBranch]);

    const branchValid = isFleetCheckoutBranchName(branch);
    useEffect(() => {
        if (!checkout) onChange({ mode: 'folder' });
        else if (mode === 'existing') onChange({ mode: 'existing', checkoutId: checkout.id, path: checkout.path });
        else if (mode === 'worktree' && branchValid) onChange({ mode: 'worktree', parentCheckoutId: checkout.id, branch });
        else if (mode === 'clone' && branchValid && checkout.remoteUrl)
            onChange({ mode: 'clone', repoUrl: checkout.remoteUrl, branch });
        else onChange({ mode: 'folder' });
        // `onChange` is the dialog's setter: stable enough, and re-running on it would loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [checkout, mode, branch, branchValid]);

    if (checkouts.length === 0) return null;

    const radio = (selected: boolean, disabled = false) =>
        cn(
            'flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-left',
            selected ? 'border-primary bg-primary/5' : 'border-border dark:border-border-dark',
            disabled && 'opacity-50 cursor-not-allowed',
        );
    const taskBranch = proposal?.source === 'task';
    const canBranch = checkout !== null && checkout.remoteUrl !== null && checkout.createdBy !== 'task';

    return (
        <div className="space-y-2" data-testid="fleet-session-where">
            <label className="block space-y-1 text-sm">
                <span className="text-text-muted dark:text-text-muted-dark">{t('checkoutLabel', { node: nodeName })}</span>
                <select
                    value={checkoutId}
                    onChange={(event) => {
                        const next = checkouts.find((row) => row.id === event.target.value) ?? null;
                        setCheckoutId(next?.id ?? '');
                        setProposal(null);
                        setEdited(false);
                        if (next) {
                            setMode(defaultWhereMode(kind, next));
                            onCwdChange(next.path);
                        }
                    }}
                    className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm"
                    data-testid="fleet-session-where-checkout"
                >
                    <option value="">{t('noCheckout')}</option>
                    {checkouts.map((row) => (
                        <option key={row.id} value={row.id}>
                            {row.repository ? `${row.repository} · ` : ''}
                            {row.path}
                            {row.branch ? ` · ${row.branch}` : ''}
                        </option>
                    ))}
                </select>
            </label>

            {checkout ? (
                <>
                    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('modeLabel')}>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={mode === 'existing'}
                            onClick={() => setMode('existing')}
                            className={radio(mode === 'existing')}
                            data-testid="fleet-session-where-existing"
                        >
                            {t('existing')}
                        </button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={mode === 'worktree'}
                            disabled={!canBranch}
                            onClick={() => setMode('worktree')}
                            className={radio(mode === 'worktree', !canBranch)}
                            data-testid="fleet-session-where-worktree"
                        >
                            {t('worktree')}
                        </button>
                        <button
                            type="button"
                            role="radio"
                            aria-checked={mode === 'clone'}
                            disabled={!canBranch}
                            onClick={() => setMode('clone')}
                            className={radio(mode === 'clone', !canBranch)}
                            data-testid="fleet-session-where-clone"
                        >
                            {t('clone')}
                        </button>
                    </div>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {mode === 'existing'
                            ? kind === 'agent'
                                ? t('existingAgentNote')
                                : t('existingNote')
                            : mode === 'worktree'
                              ? t('worktreeNote')
                              : t('cloneNote')}
                    </p>
                    {mode !== 'existing' ? (
                        <label className="block space-y-1 text-sm">
                            <span className="text-text-muted dark:text-text-muted-dark">{tBranch('label')}</span>
                            <input
                                value={branch}
                                onChange={(event) => {
                                    setBranch(event.target.value);
                                    setEdited(true);
                                }}
                                readOnly={taskBranch}
                                maxLength={FLEET_CHECKOUT_REF_MAX_LENGTH}
                                aria-invalid={branch.length > 0 && !branchValid}
                                className={cn(
                                    'w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm',
                                    branch.length > 0 && !branchValid ? 'border-danger' : 'border-border dark:border-border-dark',
                                )}
                                data-testid="fleet-session-where-branch"
                            />
                            <span className="block text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-session-where-branch-reason">
                                {proposing
                                    ? tBranch('checking')
                                    : proposalError
                                      ? proposalError
                                      : branch.length > 0 && !branchValid
                                        ? tBranch('invalid')
                                        : edited
                                          ? tBranch('edited')
                                          : proposal
                                            ? taskBranch
                                                ? tBranch('taskBranch')
                                                : proposal.suffixed
                                                  ? tBranch('suffixed', { base: proposal.base, branch: proposal.branch })
                                                  : tBranch('neverUsed', {
                                                        repository: proposal.repository ?? checkout.repository ?? '—',
                                                    })
                                            : ''}
                                {proposal && proposal.remoteChecked === false && !taskBranch ? (
                                    <> · {tBranch('remoteUnchecked')}</>
                                ) : null}
                            </span>
                        </label>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
