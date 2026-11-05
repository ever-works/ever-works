'use server';

import { startEverIdSignIn, type EverIdActionResult } from './ever-id';
import {
    everConnectProvisionAPI,
    ProvisionRequestError,
    type ProvisionDisplay,
} from '@/lib/api/ever-connect-provision';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import {
    clearProvisionCookie,
    readProvisionCookie,
    setProvisionCookie,
} from '@/lib/auth/ever-connect-provision-cookie';
import { ROUTES } from '@/lib/constants';

/**
 * The server actions of a company request from Ever. The signed request reaches
 * the server only as the body of {@link receiveProvisionIntent} (it rides in the
 * URL fragment, which no server or proxy ever logs); after that the browser holds
 * an encrypted cookie. A refusal is reduced to its wire code, which the pages
 * translate.
 */

export type ProvisionFailure =
    | 'unavailable'
    | 'invalid'
    | 'expired'
    | 'used'
    | 'rate_limited'
    | 'unreachable'
    | 'mismatch'
    | 'tenant_linked'
    | 'organization_linked'
    | 'in_progress'
    | 'invalid_value'
    | 'failed';

/** The code of a refusal, as the pages word it. */
function failureOf(error: unknown): ProvisionFailure {
    if (!(error instanceof ProvisionRequestError)) return 'unreachable';
    if (error.status === 429) return 'rate_limited';
    switch (error.code) {
        case 'intent_invalid':
        case 'product_mismatch':
            return 'invalid';
        case 'intent_expired':
        case 'intent_not_found':
            return 'expired';
        case 'intent_consumed':
        case 'idempotency_key_reused_with_different_body':
            return 'used';
        case 'not_connected':
        case 'operator_accept_required':
        case 'ever_id_unavailable':
            return 'unavailable';
        case 'connector_unavailable':
            return 'unreachable';
        case 'intent_subject_mismatch':
            return 'mismatch';
        case 'tenant_already_linked':
            return 'tenant_linked';
        case 'organization_already_linked':
            return 'organization_linked';
        case 'provisioning_in_progress':
            return 'in_progress';
        case 'slug_invalid':
        case 'template_not_found':
        case 'validation':
            return 'invalid_value';
    }
    // Every route answers 404 when the switch is off.
    if (error.status === 404) return 'unavailable';
    return 'failed';
}

export type ReceiveProvisionResult =
    | {
          success: true;
          display: ProvisionDisplay;
          signedIn: boolean;
      }
    | { success: false; failure: ProvisionFailure };

/** The landing page read a request from the URL fragment. */
export async function receiveProvisionIntent(intent: string): Promise<ReceiveProvisionResult> {
    try {
        const answer = await everConnectProvisionAPI.intake(intent);
        if (!answer.capabilities.everIdAvailable) {
            return { success: false, failure: 'unavailable' };
        }
        await setProvisionCookie({
            provisionTxn: answer.provisionTxn,
            jti: answer.jti,
            handle: answer.display.handle,
        });
        return {
            success: true,
            display: answer.display,
            signedIn: Boolean(await getAuthAccessCookie()),
        };
    } catch (error) {
        return { success: false, failure: failureOf(error) };
    }
}

/** "Continue with Ever ID": back on the confirmation page after the sign-in. */
export async function continueProvisionWithEverId(): Promise<EverIdActionResult> {
    return startEverIdSignIn(ROUTES.EVER_CONNECT_PROVISION_CONFIRM);
}

export type ProvisionCompanyResult =
    | { success: true; returnTo: string; partial: boolean }
    | { success: false; failure: ProvisionFailure };

export interface ProvisionCompanyForm {
    name?: string;
    legalName?: string;
    staffTemplateSlug?: string | null;
    firstMission?: { title: string; goal: string } | null;
}

/** "Create company". The browser sends one key per confirmation and reuses it on a retry. */
export async function confirmProvisionCompany(
    form: ProvisionCompanyForm,
    idempotencyKey: string,
): Promise<ProvisionCompanyResult> {
    const cookie = await readProvisionCookie();
    if (!cookie) return { success: false, failure: 'expired' };
    try {
        const answer = await everConnectProvisionAPI.company(
            { provisionTxn: cookie.provisionTxn, ...form },
            idempotencyKey,
        );
        await clearProvisionCookie();
        return { success: true, returnTo: answer.returnTo, partial: answer.partial };
    } catch (error) {
        return { success: false, failure: failureOf(error) };
    }
}

export type DeclineProvisionResult =
    | { success: true; returnTo: string }
    | { success: false; failure: ProvisionFailure };

/** "Not now": nothing is created; Ever Platform can offer to try again. */
export async function declineProvision(): Promise<DeclineProvisionResult> {
    const cookie = await readProvisionCookie();
    if (!cookie) return { success: false, failure: 'expired' };
    try {
        const answer = await everConnectProvisionAPI.reject(cookie.jti);
        await clearProvisionCookie();
        return { success: true, returnTo: answer.returnTo };
    } catch (error) {
        return { success: false, failure: failureOf(error) };
    }
}
