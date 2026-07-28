import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { creditsAPI, subscriptionsAPI } from '@/lib/api/credits';
import { billingAPI } from '@/lib/api/billing';
import type {
    CreditsBalance,
    CreditsLedgerPage,
    SubscriptionPlanList,
    SubscriptionPlanSummary,
} from '@/lib/api/credits.shared';
import type { BillingOverview, InvoiceListPage } from '@/lib/api/billing.shared';
import { BillingSettings } from '@/components/settings/BillingSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('billing') };
}

/**
 * Wave 13 — Billing page (billing/usage PRD §3): current plan +
 * credits-forward plan switcher, buy-credits / payment-method /
 * auto-recharge (flag-gated until a payment provider is wired),
 * invoice history, and the credits ledger.
 *
 * Server component: fetches the initial snapshot; the client handles
 * ledger paging/filtering through the `/api/credits/ledger` proxy.
 * Static page by design — no polling; refresh on navigation.
 */
interface BillingSettingsPageProps {
    /** `session_id` is appended by the payment provider on return. */
    searchParams: Promise<{ session_id?: string; plan?: string }>;
}

export default async function BillingSettingsPage({ searchParams }: BillingSettingsPageProps) {
    // Paid-plan checkout return (audit B24). The provider redirects here
    // with its session id; finalizing BEFORE the snapshot fetch means the
    // page renders the new tier immediately instead of the old one.
    //
    // This is a convenience, not the source of truth — the
    // signature-verified webhook activates the plan regardless, and both
    // paths funnel into the same idempotent activation. The API scopes
    // the call to the session user, so a session id pasted from another
    // account's redirect resolves to a 404 and is swallowed here.
    const params = await searchParams;
    if (params.session_id) {
        await billingAPI.completePlanCheckout(params.session_id).catch(() => null);
    }

    // Each fetch degrades independently: a failed call renders that
    // section's error/empty state instead of failing the whole page.
    const [plan, plans, balance, ledger, overview, invoices] = await Promise.all([
        subscriptionsAPI.currentPlan().catch((): SubscriptionPlanSummary | null => null),
        subscriptionsAPI.listPlans().catch((): SubscriptionPlanList | null => null),
        creditsAPI.balance().catch((): CreditsBalance | null => null),
        creditsAPI.ledger({ pageSize: 10 }).catch((): CreditsLedgerPage | null => null),
        // The money path (billing PRD B5) — packs, provider-configured
        // flag, payment-method summary and auto-recharge in one call.
        billingAPI.overview().catch((): BillingOverview | null => null),
        billingAPI.invoices({ pageSize: 10 }).catch((): InvoiceListPage | null => null),
    ]);

    // PRD §3.2/§3.7 — the purchase / payment-method / auto-recharge
    // surfaces sit behind a server-side MASTER SWITCH, default OFF.
    // Turning it on is necessary but not sufficient: the cards only go
    // live when the API also reports `providerConfigured` (real keys are
    // wired), so a flag flip on a keyless deployment still renders the
    // coming-soon state rather than buttons that always error.
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === 'true';

    return (
        <BillingSettings
            paymentsEnabled={paymentsEnabled}
            initialPlan={plan}
            initialPlans={plans}
            initialBalance={balance}
            initialLedger={ledger}
            initialOverview={overview}
            initialInvoices={invoices}
        />
    );
}
