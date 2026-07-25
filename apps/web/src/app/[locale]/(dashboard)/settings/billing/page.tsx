import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { creditsAPI, subscriptionsAPI } from '@/lib/api/credits';
import type {
    CreditsBalance,
    CreditsLedgerPage,
    SubscriptionPlanList,
    SubscriptionPlanSummary,
} from '@/lib/api/credits.shared';
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
export default async function BillingSettingsPage() {
    // Each fetch degrades independently: a failed call renders that
    // section's error/empty state instead of failing the whole page.
    const [plan, plans, balance, ledger] = await Promise.all([
        subscriptionsAPI.currentPlan().catch((): SubscriptionPlanSummary | null => null),
        subscriptionsAPI.listPlans().catch((): SubscriptionPlanList | null => null),
        creditsAPI.balance().catch((): CreditsBalance | null => null),
        creditsAPI.ledger({ pageSize: 10 }).catch((): CreditsLedgerPage | null => null),
    ]);

    // PRD §3.2/§3.7 — the purchase/payment-method/auto-recharge surfaces
    // ship behind a server-side flag, default OFF, until the payment
    // provider lands (Wave 9.4). Flipping PAYMENTS_ENABLED=true reveals
    // the interactive top-up UI; checkout itself stays disabled until
    // the provider checkout seam exists.
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === 'true';

    return (
        <BillingSettings
            paymentsEnabled={paymentsEnabled}
            initialPlan={plan}
            initialPlans={plans}
            initialBalance={balance}
            initialLedger={ledger}
        />
    );
}
