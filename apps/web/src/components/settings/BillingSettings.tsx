'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    AlertCircle,
    AlertTriangle,
    ArrowRight,
    CreditCard,
    FileText,
    Gauge,
    RefreshCw,
    ShieldCheck,
    Wallet,
    Zap,
    Check,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    cancelSubscriptionAction,
    changePlanAction,
    openBillingPortalAction,
    resumeSubscriptionAction,
    startCreditCheckoutAction,
    startPlanCheckoutAction,
    updateAutoRechargeAction,
    updatePaygAction,
} from '@/app/actions/dashboard/billing';
import {
    CREDIT_LEDGER_KINDS,
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
import {
    canBuyCredits,
    canCancelSubscription,
    canConfigureAutoRecharge,
    canConfigurePayg,
    canUpgradePlan,
    estimatePaygCents,
    formatCentsPerCredit,
    canResumeSubscription,
    formatCardExpiry,
    formatPaymentMethod,
    invoiceStatusTone,
    isSubscriptionPastDue,
    packBonusPercent,
    subscriptionState,
    subscriptionStatusLabelKey,
    subscriptionStatusTone,
    type BillingOverview,
    type InvoiceListPage,
    type PlanCheckoutReturnResponse,
    type PaygState,
    type SubscriptionState,
} from '@/lib/api/billing.shared';

interface BillingSettingsProps {
    paymentsEnabled: boolean;
    initialPlan: SubscriptionPlanSummary | null;
    initialPlans: SubscriptionPlanList | null;
    initialBalance: CreditsBalance | null;
    initialLedger: CreditsLedgerPage | null;
    /** Money path (billing PRD B5). Null ⇒ the overview call failed. */
    initialOverview: BillingOverview | null;
    initialInvoices: InvoiceListPage | null;
    /**
     * Result of finalising a checkout the provider just redirected back from.
     * Null when this is an ordinary page load.
     */
    checkoutReturn?: PlanCheckoutReturnResponse | null;
}

const LEDGER_PAGE_SIZE = 10;

const KIND_TONE_CLASSES: Record<ReturnType<typeof ledgerKindTone>, string> = {
    positive:
        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
    negative: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20',
    neutral:
        'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark border border-border dark:border-border-dark',
};

/** Subscription status chip tones (audit B08) — one extra `warning` bucket. */
const STATUS_TONE_CLASSES: Record<ReturnType<typeof subscriptionStatusTone>, string> = {
    ...KIND_TONE_CLASSES,
    warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20',
};

/** `Aug 12, 2026`, or null when the provider gave us no period end. */
function formatPeriodDate(value: string | null): string | null {
    if (!value) {
        return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? null
        : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

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

/**
 * Entry point to the manage-payment-methods route (billing PRD §3.3,
 * audit B10 + B25). Purely additive: the summary above stays read-only,
 * this just gives it somewhere to go.
 */
function PaymentMethodManageLink({ label }: { label: string }) {
    return (
        <Link
            href={ROUTES.DASHBOARD_SETTINGS_PAYMENT_METHOD}
            data-testid="billing-payment-method-manage"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
            {label}
            <ArrowRight className="w-3 h-3" />
        </Link>
    );
}

export function BillingSettings({
    paymentsEnabled,
    initialPlan,
    initialPlans,
    initialBalance,
    initialLedger,
    initialOverview,
    initialInvoices,
    checkoutReturn,
}: BillingSettingsProps) {
    const t = useTranslations('dashboard.settings.billing');
    const [isPending, startTransition] = useTransition();

    const subscriptionsEnabled = initialPlans?.enabled ?? initialPlan?.enabled ?? false;
    const currentPlanCode = initialPlans?.currentPlanCode ?? initialPlan?.plan?.code ?? 'free';
    const plans = initialPlans?.plans ?? [];
    // Only editions that are actually priced for a one-off purchase. Today
    // that is exactly one SKU (`selfhosted_pro` @ $99); Community Edition
    // has no prices at all and must not render a buy button.
    const licences = (initialPlans?.licences ?? []).filter(
        (licence) => Number(licence.lifetimePrice ?? 0) > 0,
    );

    // What was just bought, if anything. `ignored` means a credit top-up came
    // back through the plan route — not an error, and not something to announce.
    const justPurchased =
        checkoutReturn && checkoutReturn.status !== 'ignored' ? checkoutReturn : null;
    const purchasedLicence = justPurchased?.planCode
        ? (licences.find((l) => l.code === justPurchased.planCode) ?? null)
        : null;
    const currentPlan =
        plans.find((p) => p.isCurrent) ?? plans.find((p) => p.code === currentPlanCode) ?? null;
    const balanceCredits =
        initialOverview?.balanceCredits ?? initialBalance?.balanceCredits ?? null;

    // ── The money path ────────────────────────────────────────────────
    // Two independent gates: PAYMENTS_ENABLED (the deployment's master
    // switch, default OFF) AND providerConfigured (real provider keys are
    // wired). Both must be true before any money control goes live.
    const overview = initialOverview;
    const packs = overview?.packs ?? [];
    const buyEnabled = canBuyCredits(overview, paymentsEnabled);
    const autoRechargeEnabledUi = canConfigureAutoRecharge(overview, paymentsEnabled);

    const [selectedPackId, setSelectedPackId] = useState<string | null>(packs[0]?.id ?? null);
    const [checkoutPending, setCheckoutPending] = useState(false);

    // Paid-tier purchase (audit B24). Same two gates as buying credits,
    // plus subscriptions being enabled — an upgrade the deployment can't
    // apply must not be offered as a live button.
    const upgradeEnabled = canUpgradePlan(overview, paymentsEnabled, subscriptionsEnabled);
    const [upgradingPlanCode, setUpgradingPlanCode] = useState<string | null>(null);
    const [licencePendingCode, setLicencePendingCode] = useState<string | null>(null);
    const [licenceConfirmCode, setLicenceConfirmCode] = useState<string | null>(null);

    const [autoRechargeOn, setAutoRechargeOn] = useState(overview?.autoRecharge.enabled ?? false);
    const [autoRechargeThreshold, setAutoRechargeThreshold] = useState(
        overview?.autoRecharge.thresholdCredits != null
            ? String(overview.autoRecharge.thresholdCredits)
            : '',
    );
    const [autoRechargePackId, setAutoRechargePackId] = useState(
        overview?.autoRecharge.packId ?? packs[0]?.id ?? '',
    );
    const [autoRechargeSaving, setAutoRechargeSaving] = useState(false);

    // ── Pay-as-you-go (billing spec §3.5) ─────────────────────────────
    // Same gates as auto-recharge (payments on + provider wired + a card
    // on file); the server snapshot is the source of truth and a
    // successful mutation swaps in what the API just confirmed.
    const paygUiEnabled = canConfigurePayg(overview, paymentsEnabled);
    const [payg, setPayg] = useState<PaygState | null>(overview?.payg ?? null);
    const [paygOn, setPaygOn] = useState(overview?.payg?.enabled ?? false);
    const [paygCap, setPaygCap] = useState(
        overview?.payg ? String(overview.payg.monthlyCapCredits) : '',
    );
    const [paygSaving, setPaygSaving] = useState(false);
    const paygCapNumber = Number(paygCap);
    const paygCapEstimateCents =
        payg && Number.isFinite(paygCapNumber) && paygCapNumber > 0
            ? estimatePaygCents(paygCapNumber, payg.tiers)
            : null;
    const paygPeriodEndLabel = formatPeriodDate(payg?.periodEnd ?? null);

    const handleSavePayg = useCallback(async () => {
        setPaygSaving(true);
        try {
            const cap = Number(paygCap);
            const result = await updatePaygAction(
                paygOn
                    ? {
                          enabled: true,
                          monthlyCapCredits:
                              Number.isFinite(cap) && cap > 0 ? Math.round(cap) : undefined,
                      }
                    : { enabled: false },
            );
            if (result.success && result.payg) {
                setPayg(result.payg);
                setPaygOn(result.payg.enabled);
                setPaygCap(String(result.payg.monthlyCapCredits));
                toast.success(t('payg.saved'));
            } else {
                toast.error(result.error ?? t('payg.saveError'));
            }
        } finally {
            setPaygSaving(false);
        }
    }, [paygCap, paygOn, t]);

    const invoices = initialInvoices?.invoices ?? [];
    const paymentMethodLabel = formatPaymentMethod(overview?.paymentMethod ?? null);
    const paymentMethodExpiry = formatCardExpiry(overview?.paymentMethod ?? null);

    // ── Subscription lifecycle (audit B07/B08) ────────────────────────
    // The server snapshot is the source of truth; a successful mutation
    // swaps in what the provider just confirmed so the chip and the
    // buttons flip immediately, before the revalidated page arrives.
    const [subscription, setSubscription] = useState<SubscriptionState>(() =>
        subscriptionState(initialOverview),
    );
    const [lifecyclePending, setLifecyclePending] = useState(false);
    // Re-derive the gates from the live state rather than the initial
    // fetch, so cancel → resume swaps without a page refresh.
    const overviewWithLiveSubscription = overview ? { ...overview, subscription } : null;
    const showPastDue = isSubscriptionPastDue(overviewWithLiveSubscription);
    const showCancel = canCancelSubscription(overviewWithLiveSubscription, paymentsEnabled);
    const showResume = canResumeSubscription(overviewWithLiveSubscription, paymentsEnabled);
    const statusToneClass = STATUS_TONE_CLASSES[subscriptionStatusTone(subscription.status)];
    const periodEndLabel = formatPeriodDate(subscription.currentPeriodEnd);

    const handleCancelSubscription = useCallback(async () => {
        setLifecyclePending(true);
        try {
            const result = await cancelSubscriptionAction();
            if (result.success && result.subscription) {
                setSubscription(result.subscription);
                toast.success(t('currentPlan.cancelSuccess'));
                return;
            }
            toast.error(result.error ?? t('currentPlan.cancelError'));
        } finally {
            setLifecyclePending(false);
        }
    }, [t]);

    const handleResumeSubscription = useCallback(async () => {
        setLifecyclePending(true);
        try {
            const result = await resumeSubscriptionAction();
            if (result.success && result.subscription) {
                setSubscription(result.subscription);
                toast.success(t('currentPlan.resumeSuccess'));
                return;
            }
            toast.error(result.error ?? t('currentPlan.resumeError'));
        } finally {
            setLifecyclePending(false);
        }
    }, [t]);

    const handleOpenPortal = useCallback(async () => {
        setLifecyclePending(true);
        try {
            const result = await openBillingPortalAction();
            if (result.success && result.url) {
                window.location.assign(result.url);
                return;
            }
            toast.error(result.error ?? t('pastDue.error'));
        } finally {
            setLifecyclePending(false);
        }
    }, [t]);

    const handleBuyCredits = useCallback(async () => {
        if (!selectedPackId) {
            return;
        }
        setCheckoutPending(true);
        try {
            // Only a PACK ID crosses the wire — the server prices it.
            const result = await startCreditCheckoutAction(selectedPackId);
            if (result.success && result.url) {
                window.location.assign(result.url);
                return;
            }
            toast.error(result.error ?? t('credits.checkoutError'));
        } finally {
            setCheckoutPending(false);
        }
    }, [selectedPackId, t]);

    const handleUpgradePlan = useCallback(
        async (plan: SubscriptionPlanListItem) => {
            if (!upgradeEnabled) {
                // Degraded deployment: keep the pre-payments affordance
                // rather than a button that always errors.
                toast.info(t('plans.upgradeHint'));
                return;
            }
            setUpgradingPlanCode(plan.code);
            try {
                // Only a PLAN CODE crosses the wire — the server prices it.
                const result = await startPlanCheckoutAction(plan.code);
                if (result.success && result.url) {
                    window.location.assign(result.url);
                    return;
                }
                toast.error(result.error ?? t('credits.checkoutError'));
            } finally {
                setUpgradingPlanCode(null);
            }
        },
        [upgradeEnabled, t],
    );

    /**
     * Buy a perpetual self-hosted commercial licence.
     *
     * 🛑 Deliberately NOT wrapped in `useCallback`. The sibling
     * `handleUpgradePlan` memoizes on `[upgradeEnabled, t]`, both stable for
     * the mounted component — so any new state read inside such a callback
     * would be captured at first render and never update. For a checkout
     * handler that means charging the cadence the page opened with rather
     * than the one the buyer chose. There is nothing here worth memoizing.
     */
    const handleBuyLicence = async (licence: SubscriptionPlanListItem) => {
        if (!upgradeEnabled) {
            toast.info(t('plans.upgradeHint'));
            return;
        }
        setLicencePendingCode(licence.code);
        try {
            // `interval: lifetime` selects the one-off SKU; the server still
            // prices it from the catalog.
            const result = await startPlanCheckoutAction(licence.code, {
                interval: 'lifetime',
            });
            if (result.success && result.url) {
                window.location.assign(result.url);
                return;
            }
            toast.error(result.error ?? t('credits.checkoutError'));
        } finally {
            setLicencePendingCode(null);
            setLicenceConfirmCode(null);
        }
    };

    const handleSaveAutoRecharge = useCallback(async () => {
        setAutoRechargeSaving(true);
        try {
            const threshold = Number(autoRechargeThreshold);
            const result = await updateAutoRechargeAction({
                enabled: autoRechargeOn,
                thresholdCredits:
                    Number.isFinite(threshold) && threshold >= 0
                        ? Math.round(threshold)
                        : undefined,
                packId: autoRechargePackId || undefined,
            });
            if (result.success) {
                toast.success(t('autoRecharge.saved'));
            } else {
                toast.error(result.error ?? t('autoRecharge.saveError'));
            }
        } finally {
            setAutoRechargeSaving(false);
        }
    }, [autoRechargeOn, autoRechargeThreshold, autoRechargePackId, t]);

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

            {/* ── Just-completed checkout ──────────────────────────────────
                A perpetual licence deliberately writes no subscription row and
                grants no tier, so without this the page after a settled $99
                payment is identical to the page before it — same enabled "Buy"
                button, no invoice yet, nothing. That reads as a failed payment,
                and the obvious next action is to pay again. */}
            {justPurchased ? (
                <div
                    data-testid="billing-checkout-return"
                    className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 p-4 text-sm text-text dark:text-text-dark"
                >
                    <Check className="w-4 h-4 shrink-0 mt-0.5 text-success" />
                    <div className="space-y-1">
                        <p className="font-medium">
                            {justPurchased.status === 'active'
                                ? t('checkoutReturn.confirmed')
                                : t('checkoutReturn.settling')}
                        </p>
                        {purchasedLicence ? (
                            <p className="text-text-muted dark:text-text-muted-dark">
                                {t('checkoutReturn.licenceBody', {
                                    name: purchasedLicence.name,
                                })}
                            </p>
                        ) : null}
                    </div>
                </div>
            ) : null}

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

            {/* ── PAST_DUE recovery banner (audit B08) ─────────────── */}
            {showPastDue ? (
                <div
                    data-testid="billing-past-due-banner"
                    role="alert"
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-500/40 bg-rose-500/5 p-4"
                >
                    <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
                    <div className="flex-1 min-w-48">
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('pastDue.title')}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('pastDue.body')}
                        </p>
                    </div>
                    <Button
                        className="text-xs"
                        disabled={lifecyclePending}
                        data-testid="billing-past-due-action"
                        onClick={() => void handleOpenPortal()}
                    >
                        {t('pastDue.action')}
                    </Button>
                </div>
            ) : null}

            {/* ── Current plan ─────────────────────────────────────── */}
            <SectionCard
                icon={CreditCard}
                title={t('currentPlan.title')}
                testId="billing-current-plan"
            >
                <div className="flex items-center justify-between gap-3">
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
                        // The REAL lifecycle status (audit B08) — this chip
                        // used to be hardcoded to "active" no matter what
                        // the provider said.
                        <span
                            data-testid="billing-plan-status"
                            data-status={subscription.status}
                            className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                                statusToneClass,
                            )}
                        >
                            {subscriptionStatusTone(subscription.status) === 'positive' ? (
                                <Check className="w-3 h-3" />
                            ) : (
                                <AlertCircle className="w-3 h-3" />
                            )}
                            {t(subscriptionStatusLabelKey(subscription.status))}
                        </span>
                    ) : null}
                </div>

                {/* Cancel / resume (audit B07) — only ever rendered for a
                    subscription the provider can actually act on. */}
                {subscription.cancelAtPeriodEnd ? (
                    <p
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="billing-cancel-scheduled"
                    >
                        {periodEndLabel
                            ? t('currentPlan.cancelScheduledOn', { date: periodEndLabel })
                            : t('currentPlan.cancelScheduled')}
                    </p>
                ) : null}

                {showCancel || showResume ? (
                    <div className="flex flex-wrap gap-2">
                        {showResume ? (
                            <Button
                                className="text-xs"
                                disabled={lifecyclePending}
                                data-testid="billing-subscription-resume"
                                onClick={() => void handleResumeSubscription()}
                            >
                                {t('currentPlan.resume')}
                            </Button>
                        ) : null}
                        {showCancel ? (
                            <Button
                                variant="secondary"
                                className="text-xs"
                                disabled={lifecyclePending}
                                data-testid="billing-subscription-cancel"
                                onClick={() => void handleCancelSubscription()}
                            >
                                {t('currentPlan.cancel')}
                            </Button>
                        ) : null}
                    </div>
                ) : null}
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
                                    // path only (EW-711 #23): this starts a hosted
                                    // plan checkout (audit B24). On a deployment
                                    // without payments it degrades to the original
                                    // coming-soon hint rather than erroring.
                                    <Button
                                        className="text-xs w-full"
                                        data-testid={`billing-plan-upgrade-${plan.code}`}
                                        disabled={upgradingPlanCode !== null}
                                        onClick={() => void handleUpgradePlan(plan)}
                                    >
                                        {upgradingPlanCode === plan.code
                                            ? t('credits.redirecting')
                                            : t('plans.upgrade')}
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </SectionCard>

            {/* ── Commercial licence (self-hosted) ──────────────────────────
                Deliberately its own card, BELOW the switcher and never inside
                it. A licence is not a tier you can switch to: the activation
                path writes no subscription row and grants no plan, because it
                applies to the deployment the buyer runs themselves. Putting it
                in the switcher would read as "upgrade", and a buyer would pay
                $99 expecting their hosted plan to change. */}
            {licences.length > 0 && (
                <SectionCard
                    icon={ShieldCheck}
                    title={t('licence.title')}
                    subtitle={t('licence.subtitle')}
                    testId="billing-licences"
                >
                    <div className="space-y-3">
                        {licences.map((licence) => (
                            <div
                                key={licence.code}
                                className="rounded-lg border border-border/60 p-4"
                                data-testid={`billing-licence-${licence.code}`}
                            >
                                <div className="flex items-baseline justify-between gap-3">
                                    <p className="text-sm font-medium">{licence.name}</p>
                                    <p className="text-sm font-semibold">
                                        {formatMonthlyPrice(
                                            String(licence.lifetimePrice ?? '0'),
                                            licence.currency,
                                        )}
                                    </p>
                                </div>
                                <p className="mt-2 text-xs text-muted-foreground">
                                    {t('licence.explainer')}
                                </p>
                                {licenceConfirmCode === licence.code ? (
                                    <div className="mt-3 flex flex-col gap-2">
                                        <p className="text-xs text-muted-foreground">
                                            {t('licence.confirmBody')}
                                        </p>
                                        <div className="flex gap-2">
                                            <Button
                                                className="text-xs"
                                                data-testid={`billing-licence-confirm-${licence.code}`}
                                                disabled={licencePendingCode !== null}
                                                onClick={() => void handleBuyLicence(licence)}
                                            >
                                                {licencePendingCode === licence.code
                                                    ? t('credits.redirecting')
                                                    : t('licence.confirmCta')}
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                className="text-xs"
                                                disabled={licencePendingCode !== null}
                                                onClick={() => setLicenceConfirmCode(null)}
                                            >
                                                {t('licence.cancel')}
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <Button
                                        className="mt-3 text-xs"
                                        data-testid={`billing-licence-buy-${licence.code}`}
                                        disabled={licencePendingCode !== null}
                                        onClick={() => setLicenceConfirmCode(licence.code)}
                                    >
                                        {t('licence.buyLifetime', {
                                            price: formatMonthlyPrice(
                                                String(licence.lifetimePrice ?? '0'),
                                                licence.currency,
                                            ),
                                        })}
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                </SectionCard>
            )}

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

                {buyEnabled ? (
                    <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-3">
                            {packs.map((pack) => {
                                const bonus = packBonusPercent(pack);
                                return (
                                    <button
                                        key={pack.id}
                                        type="button"
                                        data-testid={`billing-pack-${pack.id}`}
                                        aria-pressed={selectedPackId === pack.id}
                                        onClick={() => setSelectedPackId(pack.id)}
                                        className={cn(
                                            'rounded-lg border p-3 text-left transition-colors',
                                            selectedPackId === pack.id
                                                ? 'border-primary/60 bg-primary/5'
                                                : 'border-border dark:border-border-dark hover:border-primary/40',
                                        )}
                                    >
                                        <p className="text-sm font-semibold text-text dark:text-text-dark">
                                            {pack.credits.toLocaleString('en-US')}
                                        </p>
                                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('credits.packPrice', {
                                                price: formatCreditsAsDollars(
                                                    pack.priceCents,
                                                    pack.currency,
                                                ),
                                            })}
                                        </p>
                                        {bonus > 0 ? (
                                            <span className="mt-1 inline-flex rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                                {t('credits.packBonus', { percent: bonus })}
                                            </span>
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                        <Button
                            className="text-xs"
                            data-testid="billing-buy-button"
                            disabled={!selectedPackId || checkoutPending}
                            onClick={() => void handleBuyCredits()}
                        >
                            {checkoutPending ? t('credits.redirecting') : t('credits.buy')}
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

            {/* ── Payment method + auto-recharge (PRD §3.3/§3.4) ────── */}
            <div className="grid gap-4 sm:grid-cols-2">
                <SectionCard
                    icon={CreditCard}
                    title={t('paymentMethod.title')}
                    testId="billing-payment-method"
                >
                    {!buyEnabled ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('paymentMethod.comingSoon')}
                        </p>
                    ) : paymentMethodLabel ? (
                        <div data-testid="billing-payment-method-summary">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {paymentMethodLabel}
                            </p>
                            {paymentMethodExpiry ? (
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('paymentMethod.expires', { expiry: paymentMethodExpiry })}
                                </p>
                            ) : null}
                            <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('paymentMethod.managedAtCheckout')}
                            </p>
                            <PaymentMethodManageLink label={t('paymentMethod.manage')} />
                        </div>
                    ) : (
                        <div data-testid="billing-payment-method-empty">
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('paymentMethod.empty')}
                            </p>
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('paymentMethod.addAtCheckout')}
                            </p>
                            <PaymentMethodManageLink label={t('paymentMethod.addCta')} />
                        </div>
                    )}
                </SectionCard>

                <SectionCard
                    icon={RefreshCw}
                    title={t('autoRecharge.title')}
                    testId="billing-auto-recharge"
                >
                    {!autoRechargeEnabledUi ? (
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {buyEnabled
                                ? t('autoRecharge.needsPaymentMethod')
                                : t('autoRecharge.comingSoon')}
                        </p>
                    ) : (
                        <div className="space-y-3">
                            <label className="flex items-center gap-2 text-sm text-text dark:text-text-dark">
                                <input
                                    type="checkbox"
                                    checked={autoRechargeOn}
                                    data-testid="billing-auto-recharge-toggle"
                                    onChange={(e) => setAutoRechargeOn(e.target.checked)}
                                    className="rounded border-border dark:border-border-dark"
                                />
                                {t('autoRecharge.description')}
                            </label>
                            <div className="flex flex-wrap items-center gap-2">
                                <input
                                    type="number"
                                    min="0"
                                    inputMode="numeric"
                                    placeholder={t('autoRecharge.thresholdPlaceholder')}
                                    value={autoRechargeThreshold}
                                    disabled={!autoRechargeOn}
                                    data-testid="billing-auto-recharge-threshold"
                                    onChange={(e) => setAutoRechargeThreshold(e.target.value)}
                                    className="w-32 rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-1.5 text-xs text-text dark:text-text-dark disabled:opacity-50"
                                />
                                <Select
                                    value={autoRechargePackId}
                                    onValueChange={(value: string) => setAutoRechargePackId(value)}
                                >
                                    {packs.map((pack) => (
                                        <option key={pack.id} value={pack.id}>
                                            {pack.credits.toLocaleString('en-US')} —{' '}
                                            {formatCreditsAsDollars(pack.priceCents, pack.currency)}
                                        </option>
                                    ))}
                                </Select>
                            </div>
                            {overview && overview.autoRecharge.failureCount > 0 ? (
                                <p
                                    className="text-xs text-danger"
                                    data-testid="billing-auto-recharge-failures"
                                >
                                    {t('autoRecharge.failures', {
                                        count: overview.autoRecharge.failureCount,
                                    })}
                                </p>
                            ) : null}
                            <Button
                                variant="secondary"
                                className="text-xs"
                                disabled={autoRechargeSaving}
                                data-testid="billing-auto-recharge-save"
                                onClick={() => void handleSaveAutoRecharge()}
                            >
                                {t('autoRecharge.save')}
                            </Button>
                        </div>
                    )}
                </SectionCard>
            </div>

            {/* ── Pay-as-you-go (billing spec §3.5) ─────────────────────── */}
            <SectionCard icon={Gauge} title={t('payg.title')} testId="billing-payg">
                {!paygUiEnabled || !payg ? (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {buyEnabled ? t('payg.needsPaymentMethod') : t('payg.comingSoon')}
                    </p>
                ) : (
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <label className="flex items-center gap-2 text-sm text-text dark:text-text-dark">
                                <input
                                    type="checkbox"
                                    checked={paygOn}
                                    data-testid="billing-payg-toggle"
                                    onChange={(e) => setPaygOn(e.target.checked)}
                                    className="rounded border-border dark:border-border-dark"
                                />
                                {t('payg.toggle')}
                            </label>
                            <span
                                className={cn(
                                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                                    payg.pastDue
                                        ? STATUS_TONE_CLASSES.negative
                                        : payg.enabled
                                          ? STATUS_TONE_CLASSES.positive
                                          : STATUS_TONE_CLASSES.neutral,
                                )}
                                data-testid="billing-payg-status"
                            >
                                {payg.pastDue
                                    ? t('payg.statusPastDue')
                                    : payg.enabled
                                      ? t('payg.statusOn')
                                      : t('payg.statusOff')}
                            </span>
                        </div>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('payg.description')}
                        </p>
                        {payg.pastDue ? (
                            <div
                                className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3 text-xs text-text dark:text-text-dark"
                                data-testid="billing-payg-past-due"
                            >
                                <AlertTriangle className="w-4 h-4 shrink-0 text-danger" />
                                <span>{t('payg.pastDue')}</span>
                            </div>
                        ) : null}
                        {payg.enabled ? (
                            <p
                                className="text-xs text-text dark:text-text-dark"
                                data-testid="billing-payg-cycle"
                            >
                                {t('payg.thisCycle', {
                                    used: payg.cycleUsedCredits.toLocaleString('en-US'),
                                    cap: payg.monthlyCapCredits.toLocaleString('en-US'),
                                    estimate: formatCreditsAsDollars(payg.cycleEstimateCents),
                                })}
                                {paygPeriodEndLabel
                                    ? ` · ${t('payg.cycleEnds', { date: paygPeriodEndLabel })}`
                                    : null}
                            </p>
                        ) : null}
                        <div className="flex flex-wrap items-end gap-3">
                            <label className="flex flex-col gap-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('payg.capLabel')}
                                <input
                                    type="number"
                                    min={payg.minMonthlyCapCredits}
                                    max={payg.maxMonthlyCapCredits}
                                    step="100"
                                    inputMode="numeric"
                                    value={paygCap}
                                    disabled={!paygOn}
                                    data-testid="billing-payg-cap"
                                    onChange={(e) => setPaygCap(e.target.value)}
                                    className="w-40 rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-1.5 text-xs text-text dark:text-text-dark disabled:opacity-50"
                                />
                            </label>
                            {paygCapEstimateCents !== null ? (
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    ≈ {formatCreditsAsDollars(paygCapEstimateCents)} / cycle at the
                                    cap
                                </span>
                            ) : null}
                        </div>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('payg.capHint')}{' '}
                            {t('payg.capRange', {
                                min: payg.minMonthlyCapCredits.toLocaleString('en-US'),
                                max: payg.maxMonthlyCapCredits.toLocaleString('en-US'),
                            })}
                        </p>
                        <div>
                            <p className="text-xs font-medium text-text dark:text-text-dark">
                                {t('payg.tiersTitle')}
                            </p>
                            <ul
                                className="mt-1 space-y-0.5 text-xs text-text-muted dark:text-text-muted-dark"
                                data-testid="billing-payg-tiers"
                            >
                                {payg.tiers.map((tier, index) => {
                                    const from =
                                        index === 0 ? 1 : (payg.tiers[index - 1].upTo ?? 0) + 1;
                                    return (
                                        <li key={`${tier.upTo ?? 'inf'}-${tier.centsPerCredit}`}>
                                            {tier.upTo === null
                                                ? t('payg.tierRowOpen', {
                                                      from: from.toLocaleString('en-US'),
                                                  })
                                                : t('payg.tierRow', {
                                                      from: from.toLocaleString('en-US'),
                                                      to: tier.upTo.toLocaleString('en-US'),
                                                  })}
                                            {' — '}
                                            {t('payg.perCredit', {
                                                rate: formatCentsPerCredit(tier.centsPerCredit),
                                            })}
                                        </li>
                                    );
                                })}
                            </ul>
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('payg.invoiceThreshold', {
                                    amount: formatCreditsAsDollars(payg.invoiceThresholdCents),
                                })}
                            </p>
                        </div>
                        <Button
                            variant="secondary"
                            className="text-xs"
                            disabled={paygSaving}
                            data-testid="billing-payg-save"
                            onClick={() => void handleSavePayg()}
                        >
                            {t('payg.save')}
                        </Button>
                    </div>
                )}
            </SectionCard>

            {/* ── Invoice history (PRD §3.5) — fed by the webhook mirror ── */}
            <SectionCard icon={FileText} title={t('invoices.title')} testId="billing-invoices">
                {invoices.length === 0 ? (
                    <p
                        className="text-sm text-text-muted dark:text-text-muted-dark py-4 text-center"
                        data-testid="billing-invoices-empty"
                    >
                        {t('invoices.empty')}
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm" data-testid="billing-invoices-table">
                            <thead>
                                <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                                    <th className="py-2 pr-4 font-medium">
                                        {t('invoices.colNumber')}
                                    </th>
                                    <th className="py-2 pr-4 font-medium">
                                        {t('invoices.colDate')}
                                    </th>
                                    <th className="py-2 pr-4 font-medium">
                                        {t('invoices.colStatus')}
                                    </th>
                                    <th className="py-2 pr-4 font-medium text-right">
                                        {t('invoices.colTotal')}
                                    </th>
                                    <th className="py-2 font-medium text-right" />
                                </tr>
                            </thead>
                            <tbody>
                                {invoices.map((invoice) => (
                                    <tr
                                        key={invoice.id}
                                        data-testid="billing-invoice-row"
                                        className="border-b border-border/60 dark:border-border-dark/60 last:border-0"
                                    >
                                        <td className="py-2 pr-4 text-text dark:text-text-dark">
                                            {invoice.number ?? '—'}
                                        </td>
                                        <td className="py-2 pr-4 whitespace-nowrap text-text-muted dark:text-text-muted-dark">
                                            {new Date(invoice.issuedAt).toLocaleDateString(
                                                undefined,
                                                { year: 'numeric', month: 'short', day: 'numeric' },
                                            )}
                                        </td>
                                        <td className="py-2 pr-4">
                                            <span
                                                className={cn(
                                                    'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                                                    KIND_TONE_CLASSES[
                                                        invoiceStatusTone(invoice.status)
                                                    ],
                                                )}
                                            >
                                                {t(`invoices.statuses.${invoice.status}`)}
                                            </span>
                                        </td>
                                        <td className="py-2 pr-4 text-right whitespace-nowrap text-text dark:text-text-dark">
                                            {formatCreditsAsDollars(
                                                invoice.totalCents,
                                                invoice.currency,
                                            )}
                                        </td>
                                        <td className="py-2 text-right">
                                            {invoice.hostedUrl ? (
                                                <a
                                                    href={invoice.hostedUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-xs text-primary hover:underline"
                                                    data-testid="billing-invoice-link"
                                                >
                                                    {t('invoices.view')}
                                                </a>
                                            ) : null}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
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
