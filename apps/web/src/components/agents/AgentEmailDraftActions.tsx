'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
    approveDraftAction,
    discardDraftAction,
    type DraftDecisionResult,
} from '@/app/[locale]/(dashboard)/agents/[id]/inbox/actions';
import { minutesUntil } from '@/lib/agent-email-policy';

interface Props {
    agentId: string;
    messageId: string;
    /** Called after a decision lands (either way) so the list refreshes. */
    onDecided?: () => void;
}

/**
 * Agent email (AW-05) — Approve & send / Discard for one held draft.
 *
 * The buttons only ASK: the server re-checks that the message is still a
 * draft, that the caller owns it, and every send limit, so a stale page or
 * a double click cannot send twice or skip a limit.
 */
export function AgentEmailDraftActions({ agentId, messageId, onDecided }: Props) {
    const t = useTranslations('dashboard.agentsPage.email');
    const [isPending, startTransition] = useTransition();
    const [outcome, setOutcome] = useState<{
        action: 'approve' | 'discard';
        result: DraftDecisionResult;
    } | null>(null);

    const run = (action: 'approve' | 'discard') => {
        startTransition(async () => {
            const result =
                action === 'approve'
                    ? await approveDraftAction(agentId, messageId)
                    : await discardDraftAction(agentId, messageId);
            setOutcome({ action, result });
            onDecided?.();
        });
    };

    return (
        <div
            className="flex flex-col items-start gap-1"
            data-testid={`email-draft-actions-${messageId}`}
        >
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={() => run('approve')}
                    disabled={isPending}
                    className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                    {t('drafts.approve')}
                </button>
                <button
                    type="button"
                    onClick={() => run('discard')}
                    disabled={isPending}
                    className="rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                >
                    {t('drafts.discard')}
                </button>
            </div>
            {outcome ? (
                <p role="status" className="text-xs text-muted-foreground">
                    {describeOutcome(t, outcome.action, outcome.result)}
                </p>
            ) : null}
        </div>
    );
}

type Translate = ReturnType<typeof useTranslations>;

function describeOutcome(
    t: Translate,
    action: 'approve' | 'discard',
    result: DraftDecisionResult,
): string {
    if (result.ok) {
        return action === 'approve' ? t('drafts.approved') : t('drafts.discarded');
    }
    if (result.error === 'refused') {
        const refusal = result.refusal;
        if (refusal.kind === 'alreadyDecided') return t('drafts.alreadyDecided');
        if (refusal.kind === 'approvalRequired') return t('drafts.approvalRequired');
        if (refusal.limitKind === 'recipientsPerMessage') {
            return `${t('drafts.sendLimitRecipients', { used: refusal.used, cap: refusal.cap })} ${t('drafts.kept')}`;
        }
        return `${t('drafts.sendLimit', {
            used: refusal.used,
            cap: refusal.cap,
            limit: t(`policy.windows.${refusal.limitKind}`),
            minutes: minutesUntil(refusal.retryAfterSeconds),
        })} ${t('drafts.kept')}`;
    }
    if (result.error === 'duplicate') return t('drafts.alreadyDecided');
    return t('drafts.failed');
}
