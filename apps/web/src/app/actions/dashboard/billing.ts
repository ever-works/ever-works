'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { subscriptionsAPI } from '@/lib/api/credits';
import { billingAPI } from '@/lib/api/billing';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
// Security: map ApiResponseError HTTP status codes to generic client-safe
// messages instead of forwarding raw backend strings.
import { ApiResponseError } from '@/lib/api/server-api';

/**
 * Wave 13 — server action for the Billing page's plan switcher.
 *
 * Self-service moves are FREE-plan-only by design (EW-711 #23): the API
 * rejects paid plans with 403; a paid tier is activated only through a
 * billing-verified path once a payment provider is wired. Returns a
 * discriminated union (never throws) — production redacts thrown server
 * action error messages, so the client must branch on the return value.
 */
export async function changePlanAction(planCode: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await subscriptionsAPI.changePlan(planCode);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_BILLING);
        return { success: true as const, plan: result.plan, error: null };
    } catch (error) {
        // Security: log full error server-side; return a generic client-safe message.
        console.error('[changePlanAction]', error);
        let message = 'Failed to change plan';
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 403) {
                message = 'Paid plans are activated through billing and cannot be self-assigned.';
            } else if (error.statusCode === 400) {
                message = 'Plan changes are not available on this deployment.';
            } else if (error.statusCode === 404) {
                message = 'Plan not found.';
            }
        }
        return { success: false as const, plan: null, error: message };
    }
}

/**
 * Start a credit top-up (billing PRD §3.2).
 *
 * The client sends a PACK ID and nothing else; the API prices it from its
 * own table and rejects any amount field outright, so no price can be
 * influenced from the browser. Returns the provider redirect URL as a
 * discriminated union — the caller navigates (a server-action redirect()
 * to an external origin is not what we want here, since the client needs
 * to handle the failure branch inline).
 */
export async function startCreditCheckoutAction(packId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await billingAPI.startCreditCheckout(packId);
        return { success: true as const, url: result.url, error: null };
    } catch (error) {
        // Security: log full error server-side; return a generic client-safe message.
        console.error('[startCreditCheckoutAction]', error);
        let message = 'Could not start checkout';
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 503) {
                message = 'Card payments are not enabled on this deployment yet.';
            } else if (error.statusCode === 400) {
                message = 'That credit pack is no longer available.';
            }
        }
        return { success: false as const, url: null, error: message };
    }
}

/**
 * Start a paid-plan checkout (audit B24).
 *
 * The client sends a PLAN CODE and nothing else; the API prices it from
 * `subscription_plans`, refuses free plans, builds the return URLs
 * itself and scopes everything to the session user. Returns the provider
 * redirect URL as a discriminated union so the caller can render the
 * failure branch inline (production redacts thrown server-action
 * messages).
 */
export async function startPlanCheckoutAction(planCode: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await billingAPI.startPlanCheckout(planCode);
        return { success: true as const, url: result.url, error: null };
    } catch (error) {
        // Security: log full error server-side; return a generic client-safe message.
        console.error('[startPlanCheckoutAction]', error);
        let message = 'Could not start checkout';
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 503) {
                message = 'Card payments are not enabled on this deployment yet.';
            } else if (error.statusCode === 400) {
                message = 'That plan is not available for purchase.';
            } else if (error.statusCode === 404) {
                message = 'Plan not found.';
            }
        }
        return { success: false as const, url: null, error: message };
    }
}

/** Update threshold-triggered auto-recharge (billing PRD §3.4). */
export async function updateAutoRechargeAction(settings: {
    enabled: boolean;
    thresholdCredits?: number;
    packId?: string;
}) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await billingAPI.updateAutoRecharge(settings);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_BILLING);
        return { success: true as const, enabled: result.enabled, error: null };
    } catch (error) {
        console.error('[updateAutoRechargeAction]', error);
        let message = 'Failed to update auto-recharge';
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 409) {
                message = 'Add a payment method before enabling auto-recharge.';
            } else if (error.statusCode === 503) {
                message = 'Card payments are not enabled on this deployment yet.';
            } else if (error.statusCode === 400) {
                message = 'Those auto-recharge settings are not valid.';
            }
        }
        return { success: false as const, enabled: null, error: message };
    }
}

/**
 * Cancel the subscription at the end of the paid period (audit B07).
 *
 * Returns a discriminated union rather than throwing — production
 * redacts thrown server-action messages, so the client must branch on
 * the return value. 409 means "nothing to cancel", which is also the
 * answer a cross-account attempt would get.
 */
export async function cancelSubscriptionAction() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await billingAPI.cancelSubscription();
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_BILLING);
        return { success: true as const, subscription: result.subscription, error: null };
    } catch (error) {
        console.error('[cancelSubscriptionAction]', error);
        let message = 'Failed to cancel the subscription';
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 409) {
                message = 'There is no active subscription to cancel.';
            } else if (error.statusCode === 503) {
                message = 'Card payments are not enabled on this deployment yet.';
            }
        }
        return { success: false as const, subscription: null, error: message };
    }
}

/** Undo a pending at-period-end cancellation (audit B07). */
export async function resumeSubscriptionAction() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await billingAPI.resumeSubscription();
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_BILLING);
        return { success: true as const, subscription: result.subscription, error: null };
    } catch (error) {
        console.error('[resumeSubscriptionAction]', error);
        let message = 'Failed to resume the subscription';
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 409) {
                message = 'This subscription has already ended.';
            } else if (error.statusCode === 503) {
                message = 'Card payments are not enabled on this deployment yet.';
            }
        }
        return { success: false as const, subscription: null, error: message };
    }
}

/**
 * Open the provider's hosted billing portal — the PAST_DUE recovery
 * action (audit B08). The URL comes from the API, which builds the
 * return URL from its own WEB_URL; nothing from the browser is trusted.
 */
export async function openBillingPortalAction() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await billingAPI.billingPortal();
        return { success: true as const, url: result.url, error: null };
    } catch (error) {
        console.error('[openBillingPortalAction]', error);
        let message = 'Could not open the billing portal';
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 409) {
                message = 'There is no billing account to manage yet.';
            } else if (error.statusCode === 503) {
                message = 'Card payments are not enabled on this deployment yet.';
            }
        }
        return { success: false as const, url: null, error: message };
    }
}
