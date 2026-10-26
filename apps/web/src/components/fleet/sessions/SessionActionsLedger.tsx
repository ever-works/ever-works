'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { FleetSessionActionLedgerResponse } from '@ever-works/contracts';
import { getSessionActionsLedgerAction, resendSessionActionAction } from '@/app/actions/fleet-session-git';
import { Button } from '@/components/ui/button';
import { actionLabelKey, ledgerCostText, safeHttpsUrl, sessionGitErrorTitleKey } from './session-git.shared';

/**
 * Session git & actions (FL-06, spec FR-21, FR-22, FR-24, U13, R-38, §5.2) —
 * **Actions so far** under the terminal: time, action, tokens and cost (once
 * the usage scan attributed them — "unknown" until then; an owner session
 * shows "session total only"), the pull request it produced, and **Send
 * again** on one that was not delivered (never on one the computer
 * confirmed). Re-read whenever `refreshKey` changes (after a send).
 */
export function SessionActionsLedger({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
    const t = useTranslations('fleet.sessionGit.ledger');
    const tLabels = useTranslations('fleet.sessionGit.actions.labels');
    const tErrors = useTranslations('fleet.sessionGit.errorTitles');
    const locale = useLocale();
    const [data, setData] = useState<FleetSessionActionLedgerResponse | null>(null);
    const [resending, setResending] = useState<string | null>(null);

    const load = useCallback(async () => {
        const result = await getSessionActionsLedgerAction(sessionId);
        if (result.success) setData(result.data);
    }, [sessionId]);

    useEffect(() => {
        void load();
    }, [load, refreshKey]);

    if (!data || data.entries.length === 0) return null;
    const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
    const resend = async (ledgerId: string) => {
        setResending(ledgerId);
        const result = await resendSessionActionAction(sessionId, ledgerId);
        setResending(null);
        if (!result.success) {
            toast.error(`${tErrors(sessionGitErrorTitleKey(result.code))}${result.hint ? ` — ${result.hint}` : ''}`);
            return;
        }
        if (result.data.delivery !== 'delivered') toast.warning(t('stillNotDelivered'));
        void load();
    };

    return (
        <section className="space-y-2" data-testid="fleet-session-actions-ledger" aria-label={t('title')}>
            <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">{t('title')}</h2>
            <ul className="divide-y divide-border/60 dark:divide-border-dark/60 rounded-md border border-border/60 dark:border-border-dark/60">
                {data.entries.map((entry) => {
                    const prHref = safeHttpsUrl(entry.prUrl);
                    const cost = ledgerCostText(entry);
                    return (
                        <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs" data-testid="fleet-session-ledger-row">
                            <span className="tabular-nums text-text-muted dark:text-text-muted-dark">
                                {clock.format(new Date(entry.sentAt))}
                            </span>
                            <span className="font-medium text-text dark:text-text-dark">{tLabels(actionLabelKey(entry.actionId) as Parameters<typeof tLabels>[0])}</span>
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {cost.kind === 'unknown'
                                    ? t('costUnknown')
                                    : cost.kind === 'sessionTotal'
                                      ? t('sessionTotalOnly')
                                      : t('cost', { tokens: cost.tokens, cost: cost.cost })}
                            </span>
                            {entry.prNumber && prHref ? (
                                <a href={prHref} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                    → #{entry.prNumber}
                                </a>
                            ) : null}
                            {entry.delivery === 'undelivered' ? (
                                <>
                                    <span className="text-warning" data-testid="fleet-session-ledger-undelivered">
                                        {t('notDelivered')}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => void resend(entry.id)}
                                        disabled={resending !== null}
                                        data-testid="fleet-session-ledger-resend"
                                    >
                                        {t('resend')}
                                    </Button>
                                </>
                            ) : entry.delivery === 'pending' ? (
                                <span className="text-text-muted">{t('pending')}</span>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
