'use client';

import { useMemo, useState, useTransition } from 'react';
import { Plus, Trash2, AlertCircle, Download } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
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
    const t = useTranslations('dashboard.workDetail.settings.budgets');
    const tGlobal = useTranslations('dashboard.workDetail.settings.budgets.globalCap');
    const tPlugin = useTranslations('dashboard.workDetail.settings.budgets.pluginCaps');
    const tBreakdown = useTranslations('dashboard.workDetail.settings.budgets.spendByPlugin');
    const tExport = useTranslations('dashboard.workDetail.settings.budgets.export');
    const [isPending, startTransition] = useTransition();
    const [isExporting, setIsExporting] = useState(false);

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

    const runAction = (
        successKey: 'createSuccess' | 'updateSuccess' | 'deleteSuccess',
        errorKey: 'createError' | 'updateError' | 'deleteError',
        scope: 'globalCap' | 'pluginCaps',
        fn: () => Promise<{ success: boolean; error: string | null }>,
    ) => {
        const tForScope = scope === 'globalCap' ? tGlobal : tPlugin;
        startTransition(async () => {
            const result = await fn();
            if (result.success) {
                toast.success(tForScope(successKey));
            } else {
                toast.error(result.error ?? tForScope(errorKey));
            }
        });
    };

    const downloadCsv = async () => {
        setIsExporting(true);
        try {
            const response = await fetch(`/api/works/${workId}/usage/export?format=csv`, {
                method: 'GET',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const blob = await response.blob();
            const filename = (() => {
                const cd = response.headers.get('content-disposition') ?? '';
                const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
                return match ? decodeURIComponent(match[1]) : `usage-${workId}.csv`;
            })();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : tExport('csvFailed'),
            );
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <div className="space-y-8">
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('description')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={downloadCsv}
                    disabled={isExporting}
                    className="inline-flex items-center gap-2 rounded-md border border-border dark:border-border-dark px-3 py-1.5 text-sm font-medium text-text dark:text-text-dark hover:bg-surface dark:hover:bg-white/6 disabled:opacity-60"
                >
                    <Download className="w-4 h-4" />
                    {isExporting ? tExport('downloadingCsv') : tExport('downloadCsv')}
                </button>
            </header>

            <section
                className={cn(
                    'rounded-md p-1 border border-card-border dark:border-border-dark',
                )}
            >
                <div className="rounded-sm p-5 bg-card dark:bg-surface-secondary-dark border border-card-border dark:border-border-dark">
                    <div className="flex items-baseline justify-between">
                        <h2 className="text-lg font-medium text-text dark:text-text-dark">
                            {tGlobal('heading')}
                        </h2>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('periodLabel', {
                                period: periodLabel,
                                spent: formatCents(totalSpendCents, currency),
                            })}
                        </p>
                    </div>

                    <GlobalCapForm
                        workId={workId}
                        currency={currency}
                        existing={globalBudget}
                        disabled={isPending}
                        onCreate={(data) =>
                            runAction('createSuccess', 'createError', 'globalCap', () =>
                                createBudget(workId, data),
                            )
                        }
                        onUpdate={(budgetId, patch) =>
                            runAction('updateSuccess', 'updateError', 'globalCap', () =>
                                updateBudget(workId, budgetId, patch),
                            )
                        }
                        onDelete={(budgetId) =>
                            runAction('deleteSuccess', 'deleteError', 'globalCap', () =>
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
                            {tPlugin('heading')}
                        </h2>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {tPlugin('subheading')}
                        </p>
                    </div>

                    {pluginBudgets.length === 0 ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {tPlugin('empty')}
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
                                            runAction(
                                                'updateSuccess',
                                                'updateError',
                                                'pluginCaps',
                                                () => updateBudget(workId, budgetId, patch),
                                            )
                                        }
                                        onDelete={(budgetId) =>
                                            runAction(
                                                'deleteSuccess',
                                                'deleteError',
                                                'pluginCaps',
                                                () => deleteBudget(workId, budgetId),
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
                            runAction('createSuccess', 'createError', 'pluginCaps', () =>
                                createBudget(workId, data),
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
                <div className="rounded-sm p-5 bg-card dark:bg-surface-secondary-dark border border-card-border dark:border-border-dark">
                    <h2 className="text-lg font-medium text-text dark:text-text-dark">
                        {tBreakdown('heading')}
                    </h2>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-4">
                        {tBreakdown('subheading', { period: periodLabel })}
                    </p>

                    {perPlugin.length === 0 ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {tBreakdown('empty')}
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                        <th className="pb-2">{tBreakdown('columnPlugin')}</th>
                                        <th className="pb-2">{tBreakdown('columnCapability')}</th>
                                        <th className="pb-2 text-right">
                                            {tBreakdown('columnUnits')}
                                        </th>
                                        <th className="pb-2 text-right">
                                            {tBreakdown('columnCost')}
                                        </th>
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
    const tGlobal = useTranslations('dashboard.workDetail.settings.budgets.globalCap');
    const [capInput, setCapInput] = useState(
        existing ? (existing.monthlyCapCents / 100).toFixed(2) : '',
    );
    const [allowOverage, setAllowOverage] = useState(existing?.allowOverage ?? false);
    const [error, setError] = useState<string | null>(null);

    const handleSave = () => {
        setError(null);
        const cents = dollarsToCents(capInput);
        if (cents === null) {
            setError(tGlobal('errorPositive'));
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
                    {tGlobal('capLabel', { currency: currency.toUpperCase() })}
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
                    {tGlobal('allowOverageLabel')}
                </label>

                <button
                    type="button"
                    onClick={handleSave}
                    disabled={disabled}
                    className="ml-auto inline-flex items-center gap-1 rounded-md bg-button-primary dark:bg-button-primary-dark text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                >
                    {existing ? tGlobal('saveButton') : tGlobal('createButton')}
                </button>

                {existing && (
                    <button
                        type="button"
                        onClick={() => onDelete(existing.id)}
                        disabled={disabled}
                        className="inline-flex items-center gap-1 rounded-md border border-red-500/40 text-red-500 px-3 py-1.5 text-sm font-medium hover:bg-red-500/10 disabled:opacity-60"
                    >
                        <Trash2 className="w-4 h-4" /> {tGlobal('removeButton')}
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
    const tPlugin = useTranslations('dashboard.workDetail.settings.budgets.pluginCaps');
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
            setError(tPlugin('errorPositive'));
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
                    {tPlugin('rowSpend', {
                        spent: formatCents(spendCents, currency),
                        cap: formatCents(budget.monthlyCapCents, currency),
                        percent,
                    })}
                    {budget.allowOverage ? tPlugin('overageSuffix') : ''}
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
                {tPlugin('allowOverageLabel')}
            </label>

            <button
                type="button"
                onClick={handleSave}
                disabled={disabled}
                className="rounded-md bg-button-primary dark:bg-button-primary-dark text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
                {tPlugin('saveButton')}
            </button>
            <button
                type="button"
                onClick={() => onDelete(budget.id)}
                disabled={disabled}
                className="rounded-md border border-red-500/40 text-red-500 px-2 py-1.5 hover:bg-red-500/10 disabled:opacity-60"
                aria-label={tPlugin('deleteAria')}
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
    const tPlugin = useTranslations('dashboard.workDetail.settings.budgets.pluginCaps');
    const [pluginId, setPluginId] = useState('');
    const [capInput, setCapInput] = useState('');
    const [allowOverage, setAllowOverage] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleAdd = () => {
        setError(null);
        const trimmedPlugin = pluginId.trim();
        if (!trimmedPlugin) {
            setError(tPlugin('errorPluginRequired'));
            return;
        }
        if (existingPluginIds.has(trimmedPlugin)) {
            setError(tPlugin('errorPluginDuplicate'));
            return;
        }
        const cents = dollarsToCents(capInput);
        if (cents === null) {
            setError(tPlugin('errorPositive'));
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
                {tPlugin('addHeading')}
            </p>
            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col text-xs text-text-muted dark:text-text-muted-dark">
                    {tPlugin('pluginIdLabel')}
                    <input
                        type="text"
                        value={pluginId}
                        onChange={(e) => setPluginId(e.target.value)}
                        disabled={disabled}
                        placeholder={tPlugin('pluginIdPlaceholder')}
                        className="mt-1 w-44 rounded-md border border-input-border dark:border-border-dark bg-input dark:bg-surface-secondary-dark px-2 py-1.5 text-sm text-text dark:text-text-dark"
                    />
                </label>
                <label className="flex flex-col text-xs text-text-muted dark:text-text-muted-dark">
                    {tPlugin('capLabel', { currency: currency.toUpperCase() })}
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
                    {tPlugin('allowOverageLabel')}
                </label>
                <button
                    type="button"
                    onClick={handleAdd}
                    disabled={disabled}
                    className="ml-auto inline-flex items-center gap-1 rounded-md bg-button-primary dark:bg-button-primary-dark text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                >
                    <Plus className="w-4 h-4" /> {tPlugin('addButton')}
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
