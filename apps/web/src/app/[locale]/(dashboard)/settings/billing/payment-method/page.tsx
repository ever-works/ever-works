import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { billingAPI } from '@/lib/api/billing';
import { subscriptionsAPI } from '@/lib/api/credits';
import type { PaymentMethodListPage } from '@/lib/api/billing.shared';
import { isFreePlan, type SubscriptionPlanList } from '@/lib/api/credits.shared';
import { PaymentMethodSettings } from '@/components/settings/PaymentMethodSettings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.settings.billing.paymentMethod');
    return { title: t('title') };
}

/**
 * Payment-method management (billing PRD §3.3, audit B10 + B25).
 *
 * Before this route existed the payment method was read-only — it only
 * ever appeared as a side effect of buying credits. This page adds,
 * replaces and removes cards, and is purely additive: `/settings/billing`
 * keeps its read-only summary card and simply links here.
 *
 * Adding a card is a redirect to the payment provider's own hosted
 * element. No card field is rendered anywhere on this page or posted to
 * any route of ours — the only thing that comes back is brand / last
 * four / expiry plus an opaque handle.
 */
export default async function PaymentMethodSettingsPage() {
    // Each fetch degrades independently: a failed call renders the
    // error/empty state rather than failing the whole page.
    const [methods, plans] = await Promise.all([
        billingAPI.paymentMethods().catch((): PaymentMethodListPage | null => null),
        subscriptionsAPI.listPlans().catch((): SubscriptionPlanList | null => null),
    ]);

    // Same master switch as the Billing page: default OFF, and even when
    // on, the live controls need the API to report `providerConfigured`.
    const paymentsEnabled = process.env.PAYMENTS_ENABLED === 'true';

    // Drives the "you cannot remove your last card" affordance. The API
    // enforces it regardless — this only decides whether the button is
    // offered or explained.
    const currentPlan =
        plans?.plans.find((plan) => plan.isCurrent) ??
        plans?.plans.find((plan) => plan.code === plans.currentPlanCode) ??
        null;
    const onPaidPlan = Boolean(
        plans?.enabled && currentPlan && !isFreePlan({ monthlyPrice: currentPlan.monthlyPrice }),
    );

    return (
        <PaymentMethodSettings
            paymentsEnabled={paymentsEnabled}
            initialMethods={methods}
            onPaidPlan={onPaidPlan}
        />
    );
}
