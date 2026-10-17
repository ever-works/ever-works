'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';
import {
    webhooksAPI,
    type CreateWebhookInput,
    type UpdateWebhookInput,
    type WebhookDelivery,
    type WebhookSubscription,
    type WebhookTestResult,
} from '@/lib/api/webhooks';

/**
 * Settings → Webhooks server actions (EW-P1-5). The API enforces auth and
 * per-subscription ownership (cross-account ids answer 404); the gate here
 * fails closed if header forwarding is ever misconfigured, like
 * `app/actions/notification-channels.ts`.
 */
async function ensureAuth(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
}

function revalidateWebhooks(): void {
    revalidatePath('/', 'layout');
}

function messageOf(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

export interface WebhookResult {
    success: boolean;
    subscription?: WebhookSubscription;
    /** Present ONCE, after create or rotate. Never stored client-side. */
    signingSecret?: string;
    error?: string;
}

export async function createWebhook(input: CreateWebhookInput): Promise<WebhookResult> {
    await ensureAuth();
    try {
        const created = await webhooksAPI.create(input);
        revalidateWebhooks();
        return {
            success: true,
            subscription: created.subscription,
            signingSecret: created.signingSecret,
        };
    } catch (error) {
        return { success: false, error: messageOf(error, 'Failed to create the webhook') };
    }
}

export async function updateWebhook(id: string, input: UpdateWebhookInput): Promise<WebhookResult> {
    await ensureAuth();
    try {
        const subscription = await webhooksAPI.update(id, input);
        revalidateWebhooks();
        return { success: true, subscription };
    } catch (error) {
        return { success: false, error: messageOf(error, 'Failed to update the webhook') };
    }
}

export async function deleteWebhook(id: string): Promise<WebhookResult> {
    await ensureAuth();
    try {
        await webhooksAPI.remove(id);
        revalidateWebhooks();
        return { success: true };
    } catch (error) {
        return { success: false, error: messageOf(error, 'Failed to delete the webhook') };
    }
}

export async function rotateWebhookSecret(id: string): Promise<WebhookResult> {
    await ensureAuth();
    try {
        const rotated = await webhooksAPI.rotateSecret(id);
        return {
            success: true,
            subscription: rotated.subscription,
            signingSecret: rotated.signingSecret,
        };
    } catch (error) {
        return { success: false, error: messageOf(error, 'Failed to rotate the secret') };
    }
}

export async function testWebhook(
    id: string,
): Promise<{ success: boolean; result?: WebhookTestResult; error?: string }> {
    await ensureAuth();
    try {
        const result = await webhooksAPI.test(id);
        return { success: result.ok, result };
    } catch (error) {
        return { success: false, error: messageOf(error, 'Test delivery failed') };
    }
}

export async function listWebhookDeliveries(
    subscriptionId: string,
): Promise<{ success: boolean; deliveries?: WebhookDelivery[]; error?: string }> {
    await ensureAuth();
    try {
        return { success: true, deliveries: await webhooksAPI.deliveries(subscriptionId, 50) };
    } catch (error) {
        return { success: false, error: messageOf(error, 'Failed to load deliveries') };
    }
}

export async function redeliverWebhook(
    deliveryId: string,
): Promise<{ success: boolean; deliveryId?: string; error?: string }> {
    await ensureAuth();
    try {
        const result = await webhooksAPI.redeliver(deliveryId);
        return { success: result.enqueued, deliveryId: result.deliveryId };
    } catch (error) {
        return { success: false, error: messageOf(error, 'Failed to redeliver') };
    }
}

/** The caller's subscriptions, freshly read (e.g. after a test fire moved a failure streak). */
export async function listWebhooks(): Promise<{
    success: boolean;
    subscriptions?: WebhookSubscription[];
    error?: string;
}> {
    await ensureAuth();
    try {
        return { success: true, subscriptions: await webhooksAPI.list() };
    } catch (error) {
        return { success: false, error: messageOf(error, 'Failed to load webhooks') };
    }
}
