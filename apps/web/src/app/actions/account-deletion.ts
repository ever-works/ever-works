'use server';

import { getTranslations } from 'next-intl/server';
import { removeAuthAccessCookies } from '@/lib/auth';
import { ROUTES, withAppUrl } from '@/lib/constants';
import { ApiResponseError } from '@/lib/api/server-api';
import {
    accountDeletionAPI,
    type AccountDeletionPreview,
    type AccountDeletionResult,
} from '@/lib/api/account-deletion';

type ActionResult<T> = { success: true; data: T } | { success: false; error: string; gone?: boolean };

/**
 * Self-serve account deletion — server actions for the public email-link
 * pages and the signed-in Danger Zone.
 *
 * 🛑 The link token is passed in the action BODY only, never logged and never
 * put in a URL; errors from these actions never echo it.
 */

/** Public: ask for a deletion link. Always reports success, whatever the address. */
export async function requestAccountDeletion(email: string): Promise<ActionResult<null>> {
    const t = await getTranslations('auth.deleteAccount.request.errors');
    const trimmed = (email ?? '').trim();
    if (!trimmed || trimmed.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return { success: false, error: t('invalidEmail') };
    }
    try {
        await accountDeletionAPI.request(trimmed, withAppUrl(ROUTES.DELETE_ACCOUNT_CONFIRM));
    } catch (error) {
        // 429 (too many requests from this address) is the only answer that
        // differs, and it says nothing about whether the account exists.
        if (error instanceof ApiResponseError && error.statusCode === 429) {
            return { success: false, error: t('tooManyRequests') };
        }
        return { success: false, error: t('failed') };
    }
    return { success: true, data: null };
}

/** Public: what a link would delete. Does not use the link. */
export async function verifyAccountDeletion(token: string): Promise<ActionResult<AccountDeletionPreview>> {
    try {
        return { success: true, data: await accountDeletionAPI.verify(token) };
    } catch (error) {
        return linkError(error, await linkErrorMessages());
    }
}

/** Public: use the link and delete the account. */
export async function confirmAccountDeletion(token: string): Promise<ActionResult<AccountDeletionResult>> {
    try {
        const result = await accountDeletionAPI.confirm(token);
        // If this browser happened to be signed in to the deleted account,
        // its cookie now points at a revoked session — drop it.
        await removeAuthAccessCookies().catch(() => undefined);
        return { success: true, data: result };
    } catch (error) {
        return linkError(error, await linkErrorMessages());
    }
}

/** Signed in: what deleting this account would delete. */
export async function getMyAccountDeletionPreview(): Promise<ActionResult<AccountDeletionPreview>> {
    const t = await getTranslations('dashboard.dangerZone.messages');
    try {
        return { success: true, data: await accountDeletionAPI.previewMine() };
    } catch {
        return { success: false, error: t('previewFailed') };
    }
}

/** Signed in: delete this account, then sign this browser out. */
export async function deleteMyAccount(confirmEmail: string): Promise<ActionResult<AccountDeletionResult>> {
    const t = await getTranslations('dashboard.dangerZone.messages');
    if (process.env.ACCOUNT_DELETION_DISABLED === 'true') {
        // Operator kill switch (e.g. a public demo instance).
        const legacy = await getTranslations('actions.settings.danger');
        return { success: false, error: legacy('deleteDisabled') };
    }
    try {
        const result = await accountDeletionAPI.deleteMine(confirmEmail);
        await removeAuthAccessCookies();
        return { success: true, data: result };
    } catch (error) {
        if (error instanceof ApiResponseError) {
            if (error.code === 'confirmation_mismatch') {
                return { success: false, error: t('confirmEmail') };
            }
            if (error.code === 'billing_cancel_failed') {
                return { success: false, error: t('billingCancelFailed') };
            }
        }
        return { success: false, error: t('deleteFailed') };
    }
}

interface LinkErrorMessages {
    linkInvalid: string;
    tooManyRequests: string;
    billingCancelFailed: string;
    failed: string;
}

async function linkErrorMessages(): Promise<LinkErrorMessages> {
    const t = await getTranslations('auth.deleteAccount.confirm.errors');
    return {
        linkInvalid: t('linkInvalid'),
        tooManyRequests: t('tooManyRequests'),
        billingCancelFailed: t('billingCancelFailed'),
        failed: t('failed'),
    };
}

function linkError(error: unknown, messages: LinkErrorMessages): { success: false; error: string; gone?: boolean } {
    if (error instanceof ApiResponseError) {
        if (error.statusCode === 410) {
            return { success: false, error: messages.linkInvalid, gone: true };
        }
        if (error.statusCode === 429) {
            return { success: false, error: messages.tooManyRequests };
        }
        if (error.code === 'billing_cancel_failed') {
            return { success: false, error: messages.billingCancelFailed };
        }
    }
    return { success: false, error: messages.failed };
}
