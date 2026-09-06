'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CircleDollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FleetCostCeilingView } from '@/lib/api/fleet';
import { getFleetCostCeilingAction, setFleetCostCeilingAction } from '@/app/actions/settings/fleet';
import { centsToUsdInput, formatCeilingCents, usdInputToCents } from './fleet-cost-ceiling.shared';

/**
 * Fleet cost accounting (EW-777) — the account's FLEET-WIDE daily
 * model-spend ceiling.
 *
 * Shows the ceiling in force and where it came from (the owner's value,
 * the deployment default, or none), today's spend across every node (UTC
 * day), and the day the ceiling last drained the fleet. The editor takes
 * dollars and sends whole cents; an empty field clears the owner's value
 * back to the deployment default.
 *
 * The copy is explicit about two things a user would otherwise learn the
 * hard way: the ceiling is a STOP (drained nodes stay disabled until
 * re-enabled — it is not a rate limit), and the figure it counts is the
 * CLI's own estimate, billed to the seat each node is logged in as, never
 * to platform credits.
 */
export function FleetCostCeiling() {
    const t = useTranslations('dashboard.settings.fleet.costCeiling');
    const [view, setView] = useState<FleetCostCeilingView | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [isPending, startTransition] = useTransition();

    useEffect(() => {
        startTransition(async () => {
            const result = await getFleetCostCeilingAction();
            if (result.success) {
                setView(result.data);
                setDraft(centsToUsdInput(result.data.dailyCeilingCents));
                setLoadError(null);
            } else {
                setLoadError(result.error);
            }
        });
    }, []);

    const submit = (cents: number | null) => {
        startTransition(async () => {
            const result = await setFleetCostCeilingAction(cents);
            if (result.success) {
                setView(result.data);
                setDraft(centsToUsdInput(result.data.dailyCeilingCents));
                toast.success(cents === null ? t('cleared') : t('saved'));
            } else {
                toast.error(result.error);
            }
        });
    };

    const handleSave = () => {
        const cents = usdInputToCents(draft);
        if (cents === undefined) {
            toast.error(t('invalid'));
            return;
        }
        submit(cents);
    };

    const effective = view ? formatCeilingCents(view.effectiveDailyCeilingCents) : null;
    const sourceLabel = view
        ? view.source === 'owner'
            ? t('sourceOwner')
            : view.source === 'default'
              ? t('sourceDefault')
              : t('sourceNone')
        : null;

    return (
        <div className="space-y-3" data-testid="fleet-cost-ceiling-section">
            <div className="flex items-center gap-2">
                <CircleDollarSign className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark max-w-2xl">
                {t('description')}
            </p>

            {loadError ? (
                <p className="text-sm text-warning" data-testid="fleet-cost-ceiling-error">
                    {loadError}
                </p>
            ) : null}

            {view ? (
                <dl
                    className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm max-w-2xl"
                    data-testid="fleet-cost-ceiling-summary"
                >
                    <div>
                        <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                            {t('effectiveLabel')}
                        </dt>
                        <dd
                            className="text-text dark:text-text-dark"
                            data-testid="fleet-cost-ceiling-effective"
                        >
                            {effective ?? t('noCeiling')}
                            <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                {sourceLabel}
                            </span>
                        </dd>
                    </div>
                    <div>
                        <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                            {t('todaySpend', { day: view.day })}
                        </dt>
                        <dd
                            className="text-text dark:text-text-dark"
                            data-testid="fleet-cost-ceiling-today"
                        >
                            {formatCeilingCents(view.todaySpendCents) ?? '$0.00'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-text-muted dark:text-text-muted-dark text-xs">
                            {t('trippedOn')}
                        </dt>
                        <dd className="text-text dark:text-text-dark">{view.trippedOn ?? '-'}</dd>
                    </div>
                </dl>
            ) : loadError ? null : (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('loading')}</p>
            )}

            <div className="max-w-md space-y-1.5">
                <label
                    className="block text-sm font-medium text-text dark:text-text-dark"
                    htmlFor="fleet-cost-ceiling-input"
                >
                    {t('inputLabel')}
                </label>
                <div className="flex items-center gap-2">
                    <Input
                        id="fleet-cost-ceiling-input"
                        inputMode="decimal"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                handleSave();
                            }
                        }}
                        placeholder={t('inputPlaceholder')}
                        disabled={isPending || !view}
                        data-testid="fleet-cost-ceiling-input"
                    />
                    <Button
                        onClick={handleSave}
                        loading={isPending}
                        disabled={!view}
                        data-testid="fleet-cost-ceiling-save"
                    >
                        {t('save')}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={() => submit(null)}
                        disabled={isPending || !view || view.dailyCeilingCents === null}
                        data-testid="fleet-cost-ceiling-clear"
                    >
                        {t('clear')}
                    </Button>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('hint')}</p>
            </div>
        </div>
    );
}
