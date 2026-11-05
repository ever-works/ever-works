import 'server-only';
import { cookies } from 'next/headers';
import { isPublicUrlHttps } from './cookies';
import { decrypt, encrypt } from './crypto';

/**
 * The cookie of a company request from Ever while the person signs in: the API's
 * sealed handle, the request's id and what the create-account screen shows,
 * encrypted with the web's own cookie key. HttpOnly, SameSite=Lax, Path `/`, 900
 * seconds (the longest such a request lives). It never goes into an address.
 */
export const EVER_CONNECT_PROVISION_COOKIE = 'ew_provision';

const MAX_AGE_SECONDS = 900;

export interface ProvisionCookieState {
    provisionTxn: string;
    jti: string;
    handle: string;
}

interface Stored extends ProvisionCookieState {
    v: 1;
    exp: number;
}

function options() {
    return {
        httpOnly: true,
        secure: isPublicUrlHttps(),
        sameSite: 'lax' as const,
        path: '/',
    };
}

export async function setProvisionCookie(state: ProvisionCookieState): Promise<void> {
    const stored: Stored = {
        v: 1,
        exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
        ...state,
    };
    const store = await cookies();
    store.set(EVER_CONNECT_PROVISION_COOKIE, await encrypt(JSON.stringify(stored)), {
        ...options(),
        maxAge: MAX_AGE_SECONDS,
    });
}

/** The state, or `null` when there is none, it expired or it cannot be read. */
export async function readProvisionCookie(): Promise<ProvisionCookieState | null> {
    const store = await cookies();
    const sealed = store.get(EVER_CONNECT_PROVISION_COOKIE)?.value;
    if (!sealed) return null;
    try {
        const parsed = JSON.parse(await decrypt(sealed)) as Partial<Stored>;
        if (
            parsed.v !== 1 ||
            typeof parsed.exp !== 'number' ||
            parsed.exp <= Math.floor(Date.now() / 1000) ||
            typeof parsed.provisionTxn !== 'string' ||
            typeof parsed.jti !== 'string' ||
            typeof parsed.handle !== 'string'
        ) {
            return null;
        }
        return { provisionTxn: parsed.provisionTxn, jti: parsed.jti, handle: parsed.handle };
    } catch {
        return null;
    }
}

export async function clearProvisionCookie(): Promise<void> {
    const store = await cookies();
    store.delete({ name: EVER_CONNECT_PROVISION_COOKIE, ...options() });
}
