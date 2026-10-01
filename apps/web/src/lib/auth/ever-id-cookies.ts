import 'server-only';
import type { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { cookies } from 'next/headers';
import { EVER_ID_LIMITS } from '@ever-works/contracts';
import { getRedirectCookie, isPublicUrlHttps, removeRedirectCookie } from './cookies';
import { decrypt, encrypt } from './crypto';
import { toEverIdReturnTo } from './ever-id';

/**
 * APW-12 (Ever ID) — the four short-lived cookies of the browser flow (plan §6.1,
 * T22):
 *
 * - `ew_everid_txn` — the API's sealed `transaction`, verbatim.
 * - `ew_everid_intent` — `sign-in` or `connect`, so the callback knows where an
 *   error goes.
 * - `ew_everid_pending` — the API's sealed `pending` value plus what the
 *   confirmation screens display, encrypted with the web's own cookie key
 *   (`./crypto.ts`).
 * - `ew_everid_logout_state` — the `state` of "Also sign out of Ever ID" (S7).
 *
 * Every one is HttpOnly, SameSite=Lax, `secure` from the public URL scheme (the
 * same rule as the session cookie, `./cookies.ts`), Path `/` — the confirmation
 * pages live under a locale-aware tree and the callback under `/api`, so a
 * narrower path would hide the cookie from one of them — and lives 600 seconds
 * (FR-9). The callback clears the transaction and intent on every path, and a
 * confirmation clears the pending value.
 *
 * Nothing here ever goes into an address: the values are read back only by the
 * server (FR-16, NFR-9).
 */

export const EVER_ID_TXN_COOKIE = 'ew_everid_txn';
export const EVER_ID_INTENT_COOKIE = 'ew_everid_intent';
export const EVER_ID_PENDING_COOKIE = 'ew_everid_pending';
export const EVER_ID_LOGOUT_STATE_COOKIE = 'ew_everid_logout_state';

/** FR-9 — every Ever ID cookie lives as long as the transaction it belongs to. */
export const EVER_ID_COOKIE_MAX_AGE_SECONDS = EVER_ID_LIMITS.transactionTtlSeconds;

/**
 * The largest cookie value the flow will write. Browsers drop a cookie whose name
 * and value exceed 4,096 bytes — silently — and a dropped pending cookie would
 * read as "That took too long" forever, so an oversized value is refused instead.
 */
export const EVER_ID_COOKIE_VALUE_MAX_LENGTH = 4_000;

/** Display names are trimmed to this many characters before they are stored. */
const DISPLAY_NAME_MAX_LENGTH = 128;

/** The longest `state` accepted back from the sign-out return (it is the API's). */
const LOGOUT_STATE_MAX_LENGTH = 512;

export type EverIdIntent = 'sign-in' | 'connect';

/** Which confirmation screen a pending value belongs to. */
export type EverIdPendingKind = 'signUp' | 'connect' | 'emailInUse';

/** What a confirmation screen needs, besides the API's sealed value. */
export interface EverIdPendingState {
    kind: EverIdPendingKind;
    /** The API's sealed `pending` value, sent back verbatim on confirm. */
    pending: string;
    /** The Ever ID e-mail address — display only, never used to find an account. */
    email: string;
    /** The Ever ID display name (create-account screen), when Ever ID sent one. */
    name: string | null;
    /** The signed-in account's address (connect confirmation). */
    accountEmail: string | null;
}

interface StoredPending extends EverIdPendingState {
    v: 1;
    /** Epoch seconds after which the value is treated as absent. */
    exp: number;
}

/** Raised when a value would not fit in a cookie; the caller reports S17. */
export class EverIdCookieTooLargeError extends Error {
    constructor() {
        super('Ever ID cookie value too large');
        this.name = 'EverIdCookieTooLargeError';
    }
}

function cookieOptions(): Partial<ResponseCookie> {
    return {
        httpOnly: true,
        secure: isPublicUrlHttps(),
        sameSite: 'lax',
        path: '/',
        maxAge: EVER_ID_COOKIE_MAX_AGE_SECONDS,
    };
}

async function writeCookie(name: string, value: string): Promise<void> {
    if (value.length > EVER_ID_COOKIE_VALUE_MAX_LENGTH) {
        throw new EverIdCookieTooLargeError();
    }
    const cookieStore = await cookies();
    cookieStore.set(name, value, cookieOptions());
}

async function clearCookies(...names: string[]): Promise<void> {
    const cookieStore = await cookies();
    const { httpOnly, secure, sameSite, path } = cookieOptions();
    for (const name of names) {
        // Same attributes as the write (minus `maxAge`, which would override the
        // expiry `delete` sets), so the browser matches and removes that cookie.
        cookieStore.delete({ name, httpOnly, secure, sameSite, path });
    }
}

async function readCookie(name: string): Promise<string | undefined> {
    const cookieStore = await cookies();
    const value = cookieStore.get(name)?.value;
    return value ? value : undefined;
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

// =================
// Transaction + intent
// =================

/** Remember the API's transaction and what it was started for. */
export async function setEverIdTransaction(
    transaction: string,
    intent: EverIdIntent,
): Promise<void> {
    await writeCookie(EVER_ID_TXN_COOKIE, transaction);
    await writeCookie(EVER_ID_INTENT_COOKIE, intent);
}

/**
 * Read the transaction and intent, and clear both — on every path, whatever the
 * outcome (FR-9: the transaction cookie is cleared at the callback).
 */
export async function takeEverIdTransaction(): Promise<{
    transaction: string | null;
    intent: EverIdIntent | null;
}> {
    const transaction = (await readCookie(EVER_ID_TXN_COOKIE)) ?? null;
    const rawIntent = await readCookie(EVER_ID_INTENT_COOKIE);
    await clearCookies(EVER_ID_TXN_COOKIE, EVER_ID_INTENT_COOKIE);

    const intent = rawIntent === 'sign-in' || rawIntent === 'connect' ? rawIntent : null;
    return { transaction, intent };
}

// =================
// Pending confirmation
// =================

/** Store a pending confirmation, encrypted, for {@link EVER_ID_COOKIE_MAX_AGE_SECONDS}. */
export async function setEverIdPending(state: EverIdPendingState): Promise<void> {
    const stored: StoredPending = {
        v: 1,
        exp: nowSeconds() + EVER_ID_COOKIE_MAX_AGE_SECONDS,
        kind: state.kind,
        pending: state.pending,
        email: state.email,
        name: state.name ? state.name.slice(0, DISPLAY_NAME_MAX_LENGTH) : null,
        accountEmail: state.accountEmail,
    };
    await writeCookie(EVER_ID_PENDING_COOKIE, await encrypt(JSON.stringify(stored)));
}

function isStoredPending(value: unknown): value is StoredPending {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (
        candidate.v === 1 &&
        typeof candidate.exp === 'number' &&
        (candidate.kind === 'signUp' ||
            candidate.kind === 'connect' ||
            candidate.kind === 'emailInUse') &&
        typeof candidate.pending === 'string' &&
        candidate.pending.length > 0 &&
        typeof candidate.email === 'string' &&
        (candidate.name === null || typeof candidate.name === 'string') &&
        (candidate.accountEmail === null || typeof candidate.accountEmail === 'string')
    );
}

/**
 * The pending confirmation of `kind`, or `null` when there is none, it expired,
 * it belongs to another screen or it cannot be decrypted — all of which render
 * the same "That took too long. Start again." (T25).
 */
export async function readEverIdPending(
    kind: EverIdPendingKind,
): Promise<EverIdPendingState | null> {
    const sealed = await readCookie(EVER_ID_PENDING_COOKIE);
    if (!sealed) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(await decrypt(sealed));
    } catch {
        return null;
    }

    if (!isStoredPending(parsed) || parsed.kind !== kind || parsed.exp <= nowSeconds()) {
        return null;
    }

    return {
        kind: parsed.kind,
        pending: parsed.pending,
        email: parsed.email,
        name: parsed.name,
        accountEmail: parsed.accountEmail,
    };
}

/** Forget the pending confirmation (confirm, cancel, or a dead value). */
export async function clearEverIdPending(): Promise<void> {
    await clearCookies(EVER_ID_PENDING_COOKIE);
}

// =================
// Return path
// =================

/**
 * Where a completed Ever ID sign-in (or sign-up) lands: the return path the API
 * echoed back when it is still a same-site relative path, otherwise `fallback`
 * (spec FR-10, ACC-12-12).
 *
 * When that path is the relative destination the app had stored in the
 * `redirect_url` cookie before sign-in (an organization invitation),
 * the cookie is spent here, exactly as `getRedirectUrl` spends it for the other
 * sign-in methods. An absolute stored destination is never used by this flow and
 * is left alone; the session token is never added to any address.
 */
export async function resolveEverIdReturnTo(
    returnTo: string | null | undefined,
    fallback: string,
): Promise<string> {
    const target = toEverIdReturnTo(returnTo);
    if (!target) return fallback;

    const stored = await getRedirectCookie();
    if (stored && toEverIdReturnTo(stored) === target) {
        await removeRedirectCookie();
    }
    return target;
}

// =================
// Sign-out return (S7)
// =================

/** Remember the `state` the provider's sign-out will send back. */
export async function setEverIdLogoutState(state: string): Promise<void> {
    await writeCookie(EVER_ID_LOGOUT_STATE_COOKIE, state);
}

/** Read the remembered sign-out `state` and clear it, whatever happens next. */
export async function takeEverIdLogoutState(): Promise<string | null> {
    const state = await readCookie(EVER_ID_LOGOUT_STATE_COOKIE);
    await clearCookies(EVER_ID_LOGOUT_STATE_COOKIE);
    return state && state.length <= LOGOUT_STATE_MAX_LENGTH ? state : null;
}
