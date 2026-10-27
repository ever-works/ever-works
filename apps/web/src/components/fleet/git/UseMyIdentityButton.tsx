'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetGitIdentitySetResult } from '@ever-works/contracts';
import { setGitIdentityAction } from '@/app/actions/fleet-task-handoff';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

interface Proposal {
    summary: string;
    name: string;
    email: string;
    emailSource: 'github-noreply' | 'account';
}

function readProposal(details: Record<string, unknown> | null): Proposal | null {
    if (!details) return null;
    const { summary, name, email, emailSource } = details;
    if (typeof summary !== 'string' || typeof name !== 'string' || typeof email !== 'string')
        return null;
    return {
        summary,
        name,
        email,
        emailSource: emailSource === 'account' ? 'account' : 'github-noreply',
    };
}

/**
 * Tasks on computers (FL-15 P2, spec FR-14, S8, §5.4) — **Use my Ever Works
 * identity**: asks the platform what it would set (its `confirmation_required`
 * answer names the computer, the name and the email), shows that in one
 * confirmation — with "Your account email will appear in public commits."
 * when no GitHub account is linked — and sets it only on Confirm. Nothing is
 * written on the first click.
 */
export function UseMyIdentityButton({
    nodeId,
    onDone,
    size = 'sm',
    disabled,
}: {
    nodeId: string;
    onDone?: (result: FleetGitIdentitySetResult) => void;
    /** A `Button` size; `md` is that component's default. */
    size?: 'sm' | 'md';
    disabled?: boolean;
}) {
    const t = useTranslations('fleet.gitIdentity');
    const [pending, setPending] = useState(false);
    const [proposal, setProposal] = useState<Proposal | null>(null);
    const [error, setError] = useState<string | null>(null);

    const ask = async () => {
        setPending(true);
        setError(null);
        const result = await setGitIdentityAction(nodeId, false);
        setPending(false);
        if (!result.success && result.code === 'confirmation_required') {
            const read = readProposal(result.details);
            if (read) {
                setProposal(read);
                return;
            }
        }
        if (!result.success) setError(result.hint ?? t('errors.failed'));
    };

    const confirm = async () => {
        setPending(true);
        setError(null);
        const result = await setGitIdentityAction(nodeId, true);
        setPending(false);
        if (!result.success) {
            setError(result.hint ?? t('errors.failed'));
            return;
        }
        setProposal(null);
        onDone?.(result.data);
    };

    return (
        <>
            <Button
                type="button"
                size={size}
                variant="secondary"
                onClick={() => void ask()}
                disabled={pending || disabled}
                data-testid="fleet-git-identity-use-mine"
            >
                {t('card.useMine')}
            </Button>
            {error && !proposal && (
                <span role="alert" className="text-xs text-danger">
                    {error}
                </span>
            )}
            <Dialog
                open={proposal !== null}
                onOpenChange={(open) => !pending && !open && setProposal(null)}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {proposal?.summary}
                        </DialogTitle>
                    </DialogHeader>
                    {proposal && (
                        <div className="space-y-2 text-sm" data-testid="fleet-git-identity-confirm">
                            <p>
                                {t('confirm.name')}:{' '}
                                <span className="font-medium">{proposal.name}</span>
                            </p>
                            <p>
                                {t('confirm.email')}:{' '}
                                <span className="font-mono">{proposal.email}</span>
                            </p>
                            {proposal.emailSource === 'account' && (
                                <p className="text-warning">{t('warnings.accountEmail')}</p>
                            )}
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('confirm.nothingElse')}
                            </p>
                            {error && (
                                <p role="alert" className="text-danger">
                                    {error}
                                </p>
                            )}
                        </div>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setProposal(null)}
                            disabled={pending}
                        >
                            {t('confirm.cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={() => void confirm()}
                            disabled={pending}
                            data-testid="fleet-git-identity-confirm-button"
                        >
                            {t('confirm.set')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
