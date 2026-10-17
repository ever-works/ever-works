'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
    emailAddressesAPI,
    type CreateEmailAddressDto,
    type EmailAddress,
} from '@/lib/api/email-addresses';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * EW-650 / EW-P4-3 — Settings → Integrations → Email addresses.
 *
 * Every action answers a result instead of throwing, so the page can say what
 * went wrong in words (the API's own message: "already registered", "wait a
 * minute before sending another", …).
 */
export type EmailAddressActionResult<T = undefined> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

async function requireUser(): Promise<void> {
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);
}

function failure(error: unknown, fallback: string): { success: false; data: null; error: string } {
    return {
        success: false,
        data: null,
        error: error instanceof Error && error.message ? error.message : fallback,
    };
}

export async function createEmailAddressAction(
    input: CreateEmailAddressDto,
): Promise<EmailAddressActionResult<EmailAddress>> {
    await requireUser();
    try {
        const address = await emailAddressesAPI.create(input);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_EMAILS);
        return { success: true, data: address, error: null };
    } catch (error) {
        return failure(error, 'Could not add the address');
    }
}

/** EW-P4-3 — mail the address its confirmation link. */
export async function sendEmailAddressVerificationAction(
    id: string,
): Promise<EmailAddressActionResult<{ sent: boolean; alreadyVerified: boolean }>> {
    await requireUser();
    try {
        const result = await emailAddressesAPI.triggerVerification(id);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_EMAILS);
        return {
            success: true,
            data: { sent: result.sent !== false, alreadyVerified: result.alreadyVerified === true },
            error: null,
        };
    } catch (error) {
        return failure(error, 'Could not send the confirmation email');
    }
}

export async function setEmailAddressDisabledAction(
    id: string,
    disabled: boolean,
): Promise<EmailAddressActionResult<EmailAddress>> {
    await requireUser();
    try {
        const address = await emailAddressesAPI.update(id, { disabled });
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_EMAILS);
        return { success: true, data: address, error: null };
    } catch (error) {
        return failure(
            error,
            disabled ? 'Could not disable the address' : 'Could not enable the address',
        );
    }
}

export async function removeEmailAddressAction(id: string): Promise<EmailAddressActionResult> {
    await requireUser();
    try {
        await emailAddressesAPI.remove(id);
        revalidatePath(ROUTES.DASHBOARD_SETTINGS_EMAILS);
        return { success: true, data: undefined, error: null };
    } catch (error) {
        return failure(error, 'Could not remove the address');
    }
}

/**
 * EW-P4-3 — confirm an address from its emailed link. Deliberately NOT gated
 * on a session: the confirmation is often opened from the mailbox in another
 * browser, and the one-time token is the proof. Runs only on the visitor's
 * click (never on page load), so a mail scanner that prefetches the link
 * confirms nothing.
 */
export async function confirmEmailAddressAction(
    token: string,
): Promise<EmailAddressActionResult<{ verified: boolean }>> {
    if (!token || token.length > 200) {
        return { success: true, data: { verified: false }, error: null };
    }
    try {
        const result = await emailAddressesAPI.confirm(token);
        return { success: true, data: { verified: result.verified === true }, error: null };
    } catch (error) {
        return failure(error, 'Could not confirm the address');
    }
}
