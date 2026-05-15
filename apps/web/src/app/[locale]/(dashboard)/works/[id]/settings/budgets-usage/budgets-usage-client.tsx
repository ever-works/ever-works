'use client';

import { useMemo, useState, useTransition } from 'react';
import { Plus, Trash2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils/cn';
import {
    createBudget,
    updateBudget,
    deleteBudget,
} from '@/app/actions/dashboard/budgets';
import type {
    UsageSummary,
    WorkBudget,
    PerPluginSpend,
} from '@/lib/api/types-only';

interface BudgetsUsageClientProps {
    workId: string;
    initialSummary: UsageSummary | null;
    initialBudgets: WorkBudget[];
}

function formatCents(cents: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency.toUpperCase(),
        maximumFractionDigits: 2,
    }).format(cents / 100);
}

function dollarsToCents(input: string): number | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const dollars = Number(trimmed);
    if (!Number.isFinite(dollars) || dollars <= 0) return null;
    return Math.round(dollars * 100);
}

export function BudgetsUsageClient({
    workId,
    initialSummary,
    initialBudgets,
}: BudgetsUsageClientProps) {
    const [isPending, startTransition] = useTransition();

    const globalBudget = useMemo(
        () => initialBudgets.find((b) => b.scope === 'global') ?? null,
        [initialBudgets],
    );
    const pluginBudgets = useMemo(
        () => initialBudgets.filter((b) => b.scope === 'plugin'),
        [initialBudgets],
    );

    const currency = globalBudget?.currency ?? initialSummary?.currency ?? 'usd';
    const totalSpendCents = initialSummary?.totalSpendCents ?? 0;
    const periodLabel = initialSummary?.periodLabel ?? 'this period';
    const perPlugin: PerPluginSpend[] = initialSummary?.perPlugin ?? [];
    const pluginSpendById = useMemo(() => {
        const map = new Map<string, PerPluginSpend>();
        for (const entry of perPlugin) {
            map.set(entry.pluginId, entry);
        }
        return map;
    }, [perPlugin]);

    const runAction = (label: string, fn: () => Promise<{ success: boolean; error: string | null }>) => {
        startTransition(async () => {
            const result = await fn();
            if (result.success) {
                toast.success(`${label} succeeded`);
            } else {
                toast.error(result.error ?? `${label} failed`);
            }
        });
    };

    return (
        <div className="space-y-8">
            <header>
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                    Budgets &amp; Usage
                </h1>
                <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                    Set monthly spend caps for this directory. Alerts fire at 75%, 90%, 100%; at
                    100% new plugin calls are blocked unless overage is allowed.
                </p>
            </header>

            <section
                className={cn(
                    'rounded-md p-1 border border-card-border dark:border-border-dark',
                )}
            >
                <div className="rounded-sm p-5 bg-card dark:bg-surface-secondary-dark border border-card-border dark:border-border-dark">
                    <div className="flex items-baseline justify-between">
                        <h2 className="text-lg font-medium text-text dark:text-text-dark">
                            Global cap
                        </h2>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {periodLabel} · spent {formatCents(totalSpendCents, currency)}
                        </p>
                    </div>

                    <GlobalCapForm
                        workId={workId}
                        currency={currency}
                        existing={globalBudget}
                        disabled={isPending}
                        onCreate={(data) =>
                            runAction('Create global budget', () => createBudget(workId, data))
                        }
                        onUpdate={(budgetId, patch) =>
                            runAction('Update global budget', () =>
                                updateBudget(workId, budgetId, patch),
                            )
                        }
                        onDelete={(budgetId) =>
                            runAction('Delete global budget', () =>
                                deleteBudget(workId, budgetId),
                            )
                        }
                    />
                </div>
            </section>

            <section
                className={cn(
                    'rounded-md p-1 border border-card-border dark:border-border-dark',
                )}
            >
                <div className="rounded-sm p-5 bg-card dark:bg-surface-secondary-dark border border-card-border dark:border-border-dark space-y-4">
                    <div className="flex items-baseline justify-between">
                        <h2 className="text-lg font-medium text-text dark:text-text-dark">
                            Per-plugin caps
                        </h2>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            Optional. Caps a single plugin alongside the global cap.
                        </p>
                    </div>

                    {pluginBudgets.length === 0 ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            No per-plugin caps. Add one below.
                        </p>
                    ) : (
                        <ul className="divide-y divide-card-border dark:divide-border-dark">
                            {pluginBudgets.map((budget) => {
                                const spend =
                                    pluginSpendById.get(budget.pluginId ?? '')?.costCents ?? 0;
                                return (
                                    <PluginBudgetRow
                                        key={budget.id}
                                        budget={budget}
                                        currency={currency}
                                        spendCents={spend}
                                        disabled={isPending}
                                        onUpdate={(budgetId, patch) =>
                                            runAction('Update plugin budget', () =>
                                                updateBudget(workId, budgetId, patch),
                                            )
                                        }
                                        onDelete={(budgetId) =>
                                            runAction('Delete plugin budget', () =>
                                                deleteBudget(workId, budgetId),
                                            )
                                        }
                                    />
                                );
                            })}
                        </ul>
                    )}

                    <PluginBudgetForm
                        workId={workId}
                        currency={currency}
                        existingPluginIds={new Set(pluginBudgets.map((b) => b.pluginId ?? ''))}
                        disabled={isPending}
                        onCreate={(data) =>
                            runAction('Create plugin budget', () => createBudget(workId, data))
                        }
                    />
                </div>
            </section>

            <section
                className={cn(
                    'rounded-md p-1 border border-card-border dark:border-border-dark',
                )}
            >
                <div className="rounded-sm p-5 bg-card dark:bg-surface-secondary-dark border border-card-border dark:border-border-dark">
                    <h2 className="text-lg font-medium text-text dark:text-text-dark">
                        Spend by plugin
                    </h2>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-4">
                        {periodLabel} — read-only breakdown sourced from PluginUsageEvent.
                    </p>

                    {perPlugin.length === 0 ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            No usage recorded this period.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                        <th className="pb-2">Plugin</th>
                                        <th className="pb-2">Capability</th>
                                        <th className="pb-2 text-right">Units</th>
                                        <th className="pb-2 text-right">Cost</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-card-border dark:divide-border-dark">
                                    {perPlugin.map((row) => (
                                        <tr key={`${row.capability}:${row.pluginId}`}>
                                            <td className="py-2 text-text dark:text-text-dark">
                                                {row.pluginId}
                                            </td>
                                            <td className="py-2 text-text-muted dark:text-text-muted-dark uppercase text-xs">
                                                {row.capability}
                                            </td>
                                            <td className="py-2 text-right text-text dark:text-text-dark">
                                                {row.units.toLocaleString()}
                                            </td>
                                            <td className="py-2 text-right text-text dark:text-text-dark">
                                                {formatCents(row.costCents, currency)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

interface GlobalCapFormProps {
    workId: string;
    currency: string;
    existing: WorkBudget | null;
    disabled: boolean;
    onCreate: (data: { scope: 'global'; monthlyCapCents: number; allowOverage: boolean }) => void;
    onUpdate: (budgetId: string, patch: { monthlyCapCents?: number; allowOverage?: boolean }) => void;
    onDelete: (budgetId: string) => void;
}

function GlobalCapForm({
    workId: _workId,
    currency,
    existing,
    disabled,
    onCreate,
    onUpdate,
    onDelete,
}: GlobalCapFormProps) {
    const [capInput, setCapInput] = useState(
        existing ? (existing.monthlyCapCents / 100).toFixed(2) : '',
    );
    const [allowOverage, setAllowOverage] = useState(existing?.allowOverage ?? false);
    const [error, setError] = useState<string | null>(null);

    const handleSave = () => {
        setError(null);
        const cents = dollarsToCents(capInput);
        if (cents === null) {
            setError('Enter a positive cap value (e.g. 50.00).');
            return;
        }
        if (existing) {
            const patch: { monthlyCapCents?: number; allowOverage?: boolean } = {};
            if (cents !== existing.monthlyCapCents) patch.monthlyCapCents = cents;
            if (allowOverage !== existing.allowOverage) patch.allowOverage = allowOverage;
            if (Object.keys(patch).length === 0) return;
            onUpdate(existing.id, patch);
        } else {
            onCreate({ scope: 'global', monthlyCapCents: cents, allowOverage });
        }
    };

    return (
        <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col text-xs text-text-muted dark:text-text-muted-dark">
                    Monthly cap ({currency.toUpperCase()})
                    <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={capInput}
                        onChange={(e) => setCapInput(e.target.value)}
                        disabled={disabled}
                        placeholder="50.00"
                        className="mt-1 w-32 rounded-md border border-input-border dark:border-border-dark bg-input dark:bg-surface-secondary-dark px-2 py-1.5 text-sm text-text dark:text-text-dark"
                    />
                </label>

                <label className="flex items-center gap-2 text-sm text-text dark:text-text-dark mb-1.5">
                    <input
                        type="checkbox"
                        checked={allowOverage}
                        onChange={(e) => setAllowOverage(e.target.checked)}
                        disabled={disabled}
                    />
                    Allow overage (warn but don&apos;t block at 100%)
                </label>

                <button
                    type="button"
                    onClick={handleSave}
                    disabled={disabled}
                    className="ml-auto inline-flex items-center gap-1 rounded-md bg-button-primary dark:bg-button-primary-dark text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                >
                    {existing ? 'Save' : 'Create global cap'}
                </button>

                {existing && (
                    <button
                        type="button"
                        onClick={() => onDelete(existing.id)}
                        disabled={disabled}
                        className="inline-flex items-center gap-1 rounded-md border border-red-500/40 text-red-500 px-3 py-1.5 text-sm font-medium hover:bg-red-500/10 disabled:opacity-60"
                    >
                        <Trash2 className="w-4 h-4" /> Remove
                    </button>
                )}
            </div>

            {error && (
                <p className="flex items-center gap-1 text-xs text-red-500">
                    <AlertCircle className="w-3.5 h-3.5" /> {error}
                </p>
            )}
        </div>
    );
}

interface PluginBudgetRowProps {
    budget: WorkBudget;
    currency: string;
    spendCents: number;
    disabled: boolean;
    onUpdate: (budgetId: string, patch: { monthlyCapCents?: number; allowOverage?: boolean }) => void;
    onDelete: (budgetId: string) => void;
}

function PluginBudgetRow({
    budget,
    currency,
    spendCents,
    disabled,
    onUpdate,
    onDelete,
}: PluginBudgetRowProps) {
    const [capInput, setCapInput] = useState((budget.monthlyCapCents / 100).toFixed(2));
    const [allowOverage, setAllowOverage] = useState(budget.allowOverage);
    const [error, setError] = useState<string | null>(null);

    const percent =
        budget.monthlyCapCents > 0
            ? Math.min(150, Math.round((spendCents / budget.monthlyCapCents) * 100))
            : 0;

    const handleSave = () => {
        setError(null);
        const cents = dollarsToCents(capInput);
        if (cents === null) {
            setError('Enter a positive cap.');
            return;
        }
        const patch: { monthlyCapCents?: number; allowOverage?: boolean } = {};
        if (cents !== budget.monthlyCapCents) patch.monthlyCapCents = cents;
        if (allowOverage !== budget.allowOverage) patch.allowOverage = allowOverage;
        if (Object.keys(patch).length === 0) return;
        onUpdate(budget.id, patch);
    };

    return (
        <li className="py-3 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-0">
                <p className="text-sm text-text dark:text-text-dark truncate">
                    {budget.pluginId}
                </p>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    Spent {formatCents(spendCents, currency)} of{' '}
                    {formatCents(budget.monthlyCapCents, currency)} ({percent}%)
                    {budget.allowOverage ? ' · overage allowed' : ''}
                </p>
            </div>

            <input
                type="number"
                min="0.01"
                step="0.01"
                value={capInput}
                onChange={(e) => setCapInput(e.target.value)}
                disabled={disabled}
                className="w-28 rounded-md border border-input-border dark:border-border-dark bg-input dark:bg-surface-secondary-dark px-2 py-1.5 text-sm text-text dark:text-text-dark"
            />

            <label className="flex items-center gap-2 text-xs text-text dark:text-text-dark">
                <input
                    type="checkbox"
                    checked={allowOverage}
                    onChange={(e) => setAllowOverage(e.target.checked)}
                    disabled={disabled}
                />
                Overage
            </label>

            <button
                type="button"
                onClick={handleSave}
                disabled={disabled}
                className="rounded-md bg-button-primary dark:bg-button-primary-dark text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
                Save
            </button>
            <button
                type="button"
                onClick={() => onDelete(budget.id)}
                disabled={disabled}
                className="rounded-md border border-red-500/40 text-red-500 px-2 py-1.5 hover:bg-red-500/10 disabled:opacity-60"
                aria-label="Delete budget"
            >
                <Trash2 className="w-4 h-4" />
            </button>

            {error && (
                <p className="basis-full flex items-center gap-1 text-xs text-red-500">
                    <AlertCircle className="w-3.5 h-3.5" /> {error}
                </p>
            )}
        </li>
    );
}

interface PluginBudgetFormProps {
    workId: string;
    currency: string;
    existingPluginIds: Set<string>;
    disabled: boolean;
    onCreate: (data: {
        scope: 'plugin';
        pluginId: string;
        monthlyCapCents: number;
        allowOverage: boolean;
    }) => void;
}

function PluginBudgetForm({
    workId: _workId,
    currency,
    existingPluginIds,
    disabled,
    onCreate,
}: PluginBudgetFormProps) {
    const [pluginId, setPluginId] = useState('');
    const [capInput, setCapInput] = useState('');
    const [allowOverage, setAllowOverage] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleAdd = () => {
        setError(null);
        const trimmedPlugin = pluginId.trim();
        if (!trimmedPlugin) {
            setError('Plugin id is required.');
            return;
        }
        if (existingPluginIds.has(trimmedPlugin)) {
            setError('A budget for this plugin already exists.');
            return;
        }
        const cents = dollarsToCents(capInput);
        if (cents === null) {
            setError('Enter a positive cap value.');
            return;
        }
        onCreate({
            scope: 'plugin',
            pluginId: trimmedPlugin,
            monthlyCapCents: cents,
            allowOverage,
        });
        setPluginId('');
        setCapInput('');
        setAllowOverage(false);
    };

    return (
        <div className="border-t border-card-border dark:border-border-dark pt-4 space-y-2">
            <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark uppercase tracking-wide">
                Add plugin cap
            </p>
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col text-xs text-text-muted dark:text-text-muted-dark">
                    Plugin id
                    <input
                        type="text"
                        value={pluginId}
                        onChange={(e) => setPluginId(e.target.value)}
                        disabled={disabled}
                        placeholder="e.g. openai"
                        className="mt-1 w-44 rounded-md border border-input-border dark:border-border-dark bg-input dark:bg-surface-secondary-dark px-2 py-1.5 text-sm text-text dark:text-text-dark"
                    />
                </label>
                <label className="flex flex-col text-xs text-text-muted dark:text-text-muted-dark">
                    Monthly cap ({currency.toUpperCase()})
                    <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={capInput}
                        onChange={(e) => setCapInput(e.target.value)}
                        disabled={disabled}
                        placeholder="20.00"
                        className="mt-1 w-32 rounded-md border border-input-border dark:border-border-dark bg-input dark:bg-surface-secondary-dark px-2 py-1.5 text-sm text-text dark:text-text-dark"
                    />
                </label>
                <label className="flex items-center gap-2 text-sm text-text dark:text-text-dark mb-1.5">
                    <input
                        type="checkbox"
                        checked={allowOverage}
                        onChange={(e) => setAllowOverage(e.target.checked)}
                        disabled={disabled}
                    />
                    Allow overage
                </label>
                <button
                    type="button"
                    onClick={handleAdd}
                    disabled={disabled}
                    className="ml-auto inline-flex items-center gap-1 rounded-md bg-button-primary dark:bg-button-primary-dark text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                >
                    <Plus className="w-4 h-4" /> Add cap
                </button>
            </div>
            {error && (
                <p className="flex items-center gap-1 text-xs text-red-500">
                    <AlertCircle className="w-3.5 h-3.5" /> {error}
                </p>
            )}
        </div>
    );
}
