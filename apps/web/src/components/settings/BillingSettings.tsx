'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertCircle, CreditCard, FileText, RefreshCw, Wallet, Zap, Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { changePlanAction } from '@/app/actions/dashboard/billing';
import {
    CREDIT_LEDGER_KINDS,
    CREDIT_TOPUP_PRESETS_CENTS,
    creditsForTopupCents,
    formatCreditsAsDollars,
    formatMonthlyPrice,
    formatSignedCredits,
    isFreePlan,
    ledgerKindTone,
    type CreditLedgerKind,
    type CreditsBalance,
    type CreditsLedgerPage,
    type SubscriptionPlanList,
    type SubscriptionPlanListItem,
    type SubscriptionPlanSummary,
} from '@/lib/api/credits.shared';

interface BillingSettingsProps {
    paymentsEnabled: boolean;
    initialPlan: SubscriptionPlanSummary | null;
    initialPlans: SubscriptionPlanList | null;
    initialBalance: CreditsBalance | null;
    initialLedger: CreditsLedgerPage | null;
}

const LEDGER_PAGE_SIZE = 10;

const KIND_TONE_CLASSES: Record<ReturnType<typeof ledgerKindTone>, string> = {
    positive:
        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
    negative: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20',
    neutral:
        'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark border border-border dark:border-border-dark',
};

function SectionCard({
    icon: Icon,
    title,
    subtitle,
    children,
    testId,
}: {
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
    title: string;
    subtitle?: string;
    children: React.ReactNode;
    testId?: string;
}) {
    return (
        <div
            data-testid={testId}
            className="rounded-lg border border-border dark:border-border-dark p-5 space-y-4"
        >
            <div className="flex items-center gap-2">
                <div className="rounded-md w-8 h-8 flex items-center justify-center bg-surface dark:bg-white/6">
                    <Icon className="w-4.5 h-4.5" strokeWidth={1.3} />
                </div>
                <div>
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">{title}</h3>
                    {subtitle ? (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {subtitle}
                        </p>
                    ) : null}
                </div>
            </div>
            {children}
        </div>
    );
}

export function BillingSettings({
    paymentsEnabled,
    initialPlan,
    initialPlans,
    initialBalance,
    initialLedger,
}: BillingSettingsProps) {
    const t = useTranslations('dashboard.settings.billing');
    const [isPending, startTransition] = useTransition();

    const subscriptionsEnabled = initialPlans?.enabled ?? initialPlan?.enabled ?? false;
    const currentPlanCode = initialPlans?.currentPlanCode ?? initialPlan?.plan?.code ?? 'free';
    const plans = initialPlans?.plans ?? [];
    const currentPlan =
        plans.find((p) => p.isCurrent) ?? plans.find((p) => p.code === currentPlanCode) ?? null;
    const balanceCredits = initialBalance?.balanceCredits ?? null;

    // ── Buy-credits selection (flag-gated; checkout seam lands later) ──
    const [selectedTopupCents, setSelectedTopupCents] = useState<number | null>(null);
    const [customAmount, setCustomAmount] = useState('');
    const customCents = (() => {
        const dollars = Number(customAmount);
        return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null;
    })();
    const effectiveTopupCents = customCents ?? selectedTopupCents;

    // ── Ledger paging + kind filter (client refetch via web proxy) ──
    const [ledger, setLedger] = useState<CreditsLedgerPage | null>(initialLedger);
    const [ledgerPage, setLedgerPage] = useState(initialLedger?.page ?? 1);
    const [ledgerKind, setLedgerKind] = useState<'' | CreditLedgerKind>('');
    const [ledgerLoading, setLedgerLoading] = useState(false);
    const [ledgerError, setLedgerError] = useState(false);

    const loadLedger = useCallback(async (page: number, kind: '' | CreditLedgerKind) => {
        setLedgerLoading(true);
        setLedgerError(false);
        try {
            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('pageSize', String(LEDGER_PAGE_SIZE));
            if (kind) {
                params.set('kinds', kind);
            }
            const response = await fetch(`/api/credits/ledger?${params.toString()}`, {
                method: 'GET',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = (await response.json()) as CreditsLedgerPage;
            setLedger(data);
            setLedgerPage(data.page);
        } catch {
            setLedgerError(true);
        } finally {
            setLedgerLoading(false);
        }
    }, []);

    const handleKindFilter = (kind: '' | CreditLedgerKind) => {
        setLedgerKind(kind);
        void loadLedger(1, kind);
    };

    const handleSwitchPlan = (plan: SubscriptionPlanListItem) => {
        startTransition(async () => {
            const result = await changePlanAction(plan.code);
            if (result.success) {
                toast.success(t('plans.changeSuccess', { name: plan.name }));
            } else {
                toast.error(result.error ?? t('plans.changeError'));
            }
        });
    };

    const ledgerTotalPages = ledger ? Math.max(1, Math.ceil(ledger.total / LEDGER_PAGE_SIZE)) : 1;
    const dataUnavailable = !initialPlan && !initialPlans && !initialBalance && !initialLedger;

    return (
        <div className="space-y-8" data-testid="billing-settings">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-2">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {dataUnavailable ? (
                <div
                    data-testid="billing-load-error"
                    className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm text-text dark:text-text-dark"
                >
                    <AlertCircle className="w-4 h-4 shrink-0 text-warning" />
                    {t('loadError')}
                </div>
            ) : null}

            {!subscriptionsEnabled && !dataUnavailable ? (
                <div
                    data-testid="billing-disabled-notice"
                    className="flex items-center gap-2 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4 text-sm text-text-muted dark:text-text-muted-dark"
                >
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {t('disabledNotice')}
                </div>
            ) : null}

            {/* ── Current plan ─────────────────────────────────────── */}
            <SectionCard
                icon={CreditCard}
                title={t('currentPlan.title')}
                testId="billing-current-plan"
            >
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-lg font-semibold text-text dark:text-text-dark">
                            {currentPlan?.name ?? initialPlan?.plan?.name ?? 'Free'}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {currentPlan
                                ? isFreePlan(currentPlan)
                                    ? t('plans.free')
                                    : `${formatMonthlyPrice(currentPlan.monthlyPrice, currentPlan.currency)}${t('plans.perMonth')}`
                                : t('plans.free')}
                        </p>
                    </div>
                    {subscriptionsEnabled ? (
                        <span
                            data-testid="billing-plan-status"
                            className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
                        >
                            <Check className="w-3 h-3" />
                            {t('currentPlan.statusActive')}
                        </span>
                    ) : null}
                </div>
            </SectionCard>

            {/* ── Plan switcher (credits-forward, PRD §3.1) ─────────── */}
            <SectionCard
                icon={Zap}
                title={t('plans.title')}
                subtitle={t('plans.subtitle')}
                testId="billing-plans"
            >
                {plans.length === 0 ? (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark py-4">
                        {t('plans.empty')}
                    </p>
                ) : (
                    <div className="grid gap-4 sm:grid-cols-2 @3xl/main:grid-cols-3">
                        {plans.map((plan) => (
                            <div
                                key={plan.code}
                                data-testid={`billing-plan-${plan.code}`}
                                className={cn(
                                    'rounded-lg border p-4 flex flex-col gap-3',
                                    plan.isCurrent
                                        ? 'border-primary/60 bg-primary/5'
                                        : 'border-border dark:border-border-dark',
                                )}
                            >
                                <div>
                                    <p className="text-sm font-semibold text-text dark:text-text-dark">
                                        {plan.name}
                                    </p>
                                    <p className="text-lg font-semibold text-text dark:text-text-dark">
                                        {isFreePlan(plan)
                                            ? t('plans.free')
                                            : `${formatMonthlyPrice(plan.monthlyPrice, plan.currency)}${t('plans.perMonth')}`}
                                    </p>
                                </div>
                                <ul className="text-xs text-text-muted dark:text-text-muted-dark space-y-1 flex-1">
                                    <li>{t('plans.maxWorks', { count: plan.maxWorks })}</li>
                                    <li>
                                        {t('plans.cadences', {
                                            count: plan.allowedCadences.length,
                                        })}
                                    </li>
                                    {plan.dailyFreeCredits > 0 ? (
                                        <li>
                                            {t('plans.dailyFreeCredits', {
                                                amount: formatCreditsAsDollars(
                                                    plan.dailyFreeCredits,
                                                    plan.currency,
                                                ),
                                            })}
                                        </li>
                                    ) : null}
                                    <li>{t('plans.payAsYouGo')}</li>
                                </ul>
                                {plan.isCurrent ? (
                                    <Button variant="secondary" disabled className="text-xs w-full">
                                        {t('plans.current')}
                                    </Button>
                                ) : isFreePlan(plan) ? (
                                    <Button
                                        variant="secondary"
                                        className="text-xs w-full"
                                        disabled={!subscriptionsEnabled || isPending}
                                        data-testid={`billing-plan-switch-${plan.code}`}
                                        onClick={() => handleSwitchPlan(plan)}
                                    >
                                        {t('plans.switchFree', { name: plan.name })}
                                    </Button>
                                ) : (
                                    // Paid tiers activate through a billing-verified
                                    // path only (EW-711 #23) — until the payment
                                    // provider lands this is a contact affordance.
                                    <Button
                                        className="text-xs w-full"
                                        data-testid={`billing-plan-upgrade-${plan.code}`}
                                        onClick={() => toast.info(t('plans.upgradeHint'))}
                                    >
                                        {t('plans.upgrade')}
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </SectionCard>

            {/* ── Buy credits (PRD §3.2 — flag-gated until payments land) ── */}
            <SectionCard
                icon={Wallet}
                title={t('credits.title')}
                subtitle={t('credits.buySubtitle')}
                testId="billing-buy-credits"
            >
                <div className="flex items-baseline gap-2">
                    <span
                        className="text-2xl font-semibold text-text dark:text-text-dark"
                        data-testid="billing-balance"
                    >
                        {balanceCredits === null ? '—' : formatCreditsAsDollars(balanceCredits)}
                    </span>
                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('credits.balanceLabel')}
                    </span>
                </div>

                {paymentsEnabled ? (
                    <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                            {CREDIT_TOPUP_PRESETS_CENTS.map((cents) => (
                                <Button
                                    key={cents}
                                    variant={
                                        selectedTopupCents === cents && !customCents
                                            ? 'primary'
                                            : 'secondary'
                                    }
                                    className="text-xs"
                                    data-testid={`billing-topup-${cents}`}
                                    onClick={() => {
                                        setSelectedTopupCents(cents);
                                        setCustomAmount('');
                                    }}
                                >
                                    {formatCreditsAsDollars(cents)}
                                </Button>
                            ))}
                            <input
                                type="number"
                                min="1"
                                inputMode="decimal"
                                placeholder={t('credits.customAmount')}
                                value={customAmount}
                                data-testid="billing-topup-custom"
                                onChange={(e) => setCustomAmount(e.target.value)}
                                className="w-32 rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-1.5 text-xs text-text dark:text-text-dark"
                            />
                        </div>
                        {effectiveTopupCents ? (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('credits.presetCredits', {
                                    credits:
                                        creditsForTopupCents(effectiveTopupCents).toLocaleString(
                                            'en-US',
                                        ),
                                })}
                            </p>
                        ) : null}
                        {/* Checkout stays disabled until the provider checkout
                            seam (PRD §5.2) exists on the API. */}
                        <Button disabled className="text-xs" title={t('credits.comingSoon')}>
                            {t('credits.buy')}
                        </Button>
                    </div>
                ) : (
                    <div
                        data-testid="billing-payments-coming-soon"
                        className="rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-3"
                    >
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('credits.comingSoon')}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('credits.comingSoonBody')}
                        </p>
                    </div>
                )}
            </SectionCard>

            {/* ── Payment method + auto-recharge (flag-gated, PRD §3.3/§3.4) ── */}
            <div className="grid gap-4 sm:grid-cols-2">
                <SectionCard
                    icon={CreditCard}
                    title={t('paymentMethod.title')}
                    testId="billing-payment-method"
                >
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {paymentsEnabled ? t('paymentMethod.empty') : t('paymentMethod.comingSoon')}
                    </p>
                </SectionCard>
                <SectionCard
                    icon={RefreshCw}
                    title={t('autoRecharge.title')}
                    testId="billing-auto-recharge"
                >
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {paymentsEnabled
                            ? t('autoRecharge.description')
                            : t('autoRecharge.comingSoon')}
                    </p>
                </SectionCard>
            </div>

            {/* ── Invoice history (PRD §3.5 — empty until the provider mirror lands) ── */}
            <SectionCard icon={FileText} title={t('invoices.title')} testId="billing-invoices">
                <p className="text-sm text-text-muted dark:text-text-muted-dark py-4 text-center">
                    {t('invoices.empty')}
                </p>
            </SectionCard>

            {/* ── Credits ledger (PRD §3.6) ─────────────────────────── */}
            <SectionCard
                icon={Wallet}
                title={t('ledger.title')}
                subtitle={t('ledger.subtitle')}
                testId="billing-ledger"
            >
                <div className="flex items-center justify-between gap-3">
                    <Select
                        value={ledgerKind}
                        onValueChange={(value: string) =>
                            handleKindFilter(value as '' | CreditLedgerKind)
                        }
                    >
                        <option value="">{t('ledger.filterAll')}</option>
                        {CREDIT_LEDGER_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                                {t(`ledger.kinds.${kind}`)}
                            </option>
                        ))}
                    </Select>
                </div>

                {ledgerLoading ? (
                    <p
                        className="text-sm text-text-muted dark:text-text-muted-dark py-6 text-center"
                        data-testid="billing-ledger-loading"
                    >
                        {t('ledger.loading')}
                    </p>
                ) : ledgerError ? (
                    <p
                        className="text-sm text-danger py-6 text-center"
                        data-testid="billing-ledger-error"
                    >
                        {t('ledger.loadError')}
                    </p>
                ) : !ledger || ledger.entries.length === 0 ? (
                    <p
                        className="text-sm text-text-muted dark:text-text-muted-dark py-6 text-center"
                        data-testid="billing-ledger-empty"
                    >
                        {t('ledger.empty')}
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm" data-testid="billing-ledger-table">
                            <thead>
                                <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                                    <th className="py-2 pr-4 font-medium">{t('ledger.colDate')}</th>
                                    <th className="py-2 pr-4 font-medium">{t('ledger.colType')}</th>
                                    <th className="py-2 pr-4 font-medium">
                                        {t('ledger.colDescription')}
                                    </th>
                                    <th className="py-2 pr-4 font-medium text-right">
                                        {t('ledger.colAmount')}
                                    </th>
                                    <th className="py-2 font-medium text-right">
                                        {t('ledger.colBalance')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {ledger.entries.map((entry) => (
                                    <tr
                                        key={entry.id}
                                        data-testid="billing-ledger-row"
                                        className="border-b border-border/60 dark:border-border-dark/60 last:border-0"
                                    >
                                        <td className="py-2 pr-4 whitespace-nowrap text-text-muted dark:text-text-muted-dark">
                                            {new Date(entry.createdAt).toLocaleDateString(
                                                undefined,
                                                {
                                                    year: 'numeric',
                                                    month: 'short',
                                                    day: 'numeric',
                                                },
                                            )}
                                        </td>
                                        <td className="py-2 pr-4">
                                            <span
                                                className={cn(
                                                    'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                                                    KIND_TONE_CLASSES[ledgerKindTone(entry.kind)],
                                                )}
                                            >
                                                {t(`ledger.kinds.${entry.kind}`)}
                                            </span>
                                        </td>
                                        <td className="py-2 pr-4 text-text dark:text-text-dark max-w-64 truncate">
                                            {entry.description ?? '—'}
                                        </td>
                                        <td
                                            className={cn(
                                                'py-2 pr-4 text-right font-medium whitespace-nowrap',
                                                entry.amountCredits >= 0
                                                    ? 'text-emerald-600 dark:text-emerald-400'
                                                    : 'text-text dark:text-text-dark',
                                            )}
                                        >
                                            {formatSignedCredits(entry.amountCredits)}
                                        </td>
                                        <td className="py-2 text-right whitespace-nowrap text-text-muted dark:text-text-muted-dark">
                                            {formatCreditsAsDollars(entry.balanceAfter)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {ledger && ledger.total > LEDGER_PAGE_SIZE ? (
                    <div className="flex items-center justify-between pt-1">
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('ledger.pageInfo', { page: ledgerPage, pages: ledgerTotalPages })}
                        </span>
                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                className="text-xs"
                                disabled={ledgerPage <= 1 || ledgerLoading}
                                data-testid="billing-ledger-prev"
                                onClick={() => loadLedger(ledgerPage - 1, ledgerKind)}
                            >
                                {t('ledger.pagePrev')}
                            </Button>
                            <Button
                                variant="secondary"
                                className="text-xs"
                                disabled={ledgerPage >= ledgerTotalPages || ledgerLoading}
                                data-testid="billing-ledger-next"
                                onClick={() => loadLedger(ledgerPage + 1, ledgerKind)}
                            >
                                {t('ledger.pageNext')}
                            </Button>
                        </div>
                    </div>
                ) : null}
            </SectionCard>
        </div>
    );
}
