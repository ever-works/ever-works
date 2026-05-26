'use client';

import { useState, useTransition } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import { agentsAPI } from '@/lib/api/agents';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

interface BudgetSnapshot {
    currentSpendCents: number;
    capCents: number | null;
    periodStart: string;
    periodEnd: string;
    currency: string;
}

interface Props {
    agentId: string;
    initial: BudgetSnapshot;
}

function formatMoney(cents: number, currency: string): string {
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
            currencyDisplay: 'narrowSymbol',
        }).format(cents / 100);
    } catch {
        return `${(cents / 100).toFixed(2)} ${currency}`;
    }
}

export function AgentBudgetsClient({ agentId, initial }: Props) {
    const [snapshot, setSnapshot] = useState(initial);
    const [pending, startTransition] = useTransition();

    const refresh = () => {
        startTransition(() => {
            void (async () => {
                const next = await agentsAPI.getBudget(agentId);
                setSnapshot(next);
            })();
        });
    };

    const percent =
        snapshot.capCents && snapshot.capCents > 0
            ? Math.min(100, (snapshot.currentSpendCents / snapshot.capCents) * 100)
            : null;

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <header className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Budget</h2>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={refresh}
                    disabled={pending}
                    className="gap-1.5"
                >
                    <RefreshCw className={cn('w-3.5 h-3.5', pending && 'animate-spin')} />
                    Refresh
                </Button>
            </header>
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Wallet className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1">
                        <div className="text-xs text-text-muted dark:text-text-muted-dark">
                            Spent this period
                        </div>
                        <div className="text-2xl font-semibold text-text dark:text-text-dark mt-0.5">
                            {formatMoney(snapshot.currentSpendCents, snapshot.currency)}
                        </div>
                        {snapshot.capCents != null ? (
                            <div className="text-xs text-text-muted dark:text-text-muted-dark">
                                of {formatMoney(snapshot.capCents, snapshot.currency)} cap
                            </div>
                        ) : (
                            <div className="text-xs text-text-muted dark:text-text-muted-dark">
                                no cap configured for this Agent
                            </div>
                        )}
                    </div>
                </div>

                {percent != null && (
                    <div>
                        <div className="h-2 rounded-full bg-border/40 dark:bg-border-dark/40 overflow-hidden">
                            <div
                                className={cn(
                                    'h-full transition-[width]',
                                    percent < 80
                                        ? 'bg-primary'
                                        : percent < 100
                                          ? 'bg-amber-500'
                                          : 'bg-danger',
                                )}
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                        <div className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                            {percent.toFixed(1)}% of cap used
                        </div>
                    </div>
                )}

                <div className="text-[11px] text-text-muted dark:text-text-muted-dark">
                    Window: {new Date(snapshot.periodStart).toLocaleDateString()} →{' '}
                    {new Date(snapshot.periodEnd).toLocaleDateString()}
                </div>
            </section>
        </div>
    );
}
