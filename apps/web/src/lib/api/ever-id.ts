import 'server-only';
import type { EverIdLinkedVia } from '@ever-works/contracts';
import {
    EVER_ID_RATE_LIMITED,
    isEverIdFailureCode,
    toRetryAfterSeconds,
    type EverIdCheckId,
    type EverIdFailureCode,
    type EverIdLocalClientKind,
} from '@/lib/auth/ever-id';
import { serverFetch } from './server-api';
import type { TermsAcceptanceClaim } from './auth';

/**
 * APW-12 (Ever ID) — the web's client for `/api/auth/ever-id/*` (plan §5.1).
 *
 * Every call goes through `serverFetch`, so the session cookie (when there is
 * one) travels as `Authorization: Bearer …` exactly as on every other call — the
 * connect intent needs it, and it is harmless elsewhere. Every call also selects
 * personal scope explicitly: a connected identity belongs to a person, never to
 * an Organization, and the callback and sign-out return run under `/api`, where
 * no proxy-injected workspace selector exists.
 *
 * Failures surface as {@link EverIdRequestError}: the HTTP status, the wire code
 * (`{ status: 'error', code, message }`, CONTRACTS §12) and, for a `429`, the
 * `Retry-After` wait. The API's English `message` is deliberately not kept — a
 * caller translates the code instead and never forwards upstream text.
 */

const BASE = '/auth/ever-id';

export interface EverIdUser {
    id: string;
    email: string | null;
    username: string;
}

export interface EverIdAuthorizeResponse {
    /** The provider's own authorization address — the only URL the flow navigates to off-site. */
    authorizationUrl: string;
    /** The API's sealed transaction; the web keeps it in `ew_everid_txn`. */
    transaction: string;
}

/** What `POST /callback` answers on success (plan §6.3). */
export type EverIdCallbackResult =
    | {
          outcome: 'signedIn';
          access_token: string;
          user: EverIdUser;
          returnTo: string | null;
      }
    | {
          outcome: 'confirmSignUp';
          pending: string;
          identity: { email: string; name: string | null };
          returnTo: string | null;
      }
    | {
          outcome: 'confirmConnect';
          pending: string;
          identity: { email: string };
          accountEmail: string;
      }
    | { outcome: 'emailInUse'; email: string; pending: string };

/** What `POST /sign-up/confirm` answers. */
export interface EverIdSignUpResponse {
    access_token: string;
    user: EverIdUser;
    returnTo: string | null;
}

/** An app that read the person's App Works with a delegated permission (FR-48). */
export interface EverIdDelegatedClientView {
    clientId: string;
    displayName: string;
    /** ISO timestamp. */
    lastSeenAt: string;
}

/** One connected identity, as the API shows it (issuer and subject are never sent). */
export interface EverIdIdentity {
    id: string;
    displayName: string;
    email: string;
    /** ISO timestamp. */
    linkedAt: string;
    linkedVia: EverIdLinkedVia;
    /** ISO timestamp, or `null` when it has not been used to sign in yet. */
    lastLoginAt: string | null;
    /** Already filtered to the last 30 days, newest first. */
    delegatedClients: EverIdDelegatedClientView[];
}

/** What `GET /identities` answers — even while Ever ID is turned off (FR-5). */
export interface EverIdIdentityList {
    items: EverIdIdentity[];
    canDisconnect: boolean;
    disconnectBlockedReason?: 'last_sign_in_method';
    /** Where the person manages delegated apps at Ever ID, when the provider has one. */
    manageUrl?: string;
}

export interface EverIdLogoutUrlResponse {
    /** The provider's own end-session address. */
    url: string;
    state: string;
}

/** Where an administrator's setting came from. */
export type EverIdSettingSource = 'admin' | 'env' | 'default' | 'unset';

/** One terminal client allowed to exchange an Ever ID token for a session. */
export interface EverIdLocalClientSetting {
    kind: EverIdLocalClientKind;
    clientId: string;
}

/** The name people see for an app that reads with a delegated permission. */
export interface EverIdDelegatedClientName {
    clientId: string;
    displayName: string;
}

/**
 * The administrator-managed, non-secret values (`PATCH /admin/settings`). The
 * issuer, the client and its secret are environment configuration and are not
 * part of it.
 */
export interface EverIdAdminSettings {
    displayName: string;
    accountManagementUrl: string | null;
    localClients: EverIdLocalClientSetting[];
    delegatedClientNames: EverIdDelegatedClientName[];
}

/** A `PATCH /admin/settings` body: any subset of the values. */
export type EverIdAdminSettingsPatch = Partial<EverIdAdminSettings>;

/** `GET /admin/status` (platform administrators only). Never carries the secret. */
export interface EverIdAdminStatus {
    enabled: boolean;
    configured: boolean;
    missing: string[];
    issuer: string | null;
    clientIdSet: boolean;
    clientSecretSet: boolean;
    displayName: string;
    signUpAllowed: boolean;
    /** How many terminal clients are allowed (the list itself is in `settings`). */
    localClients: number;
    unavailableSince: string | null;
    settingSources: Record<string, EverIdSettingSource>;
    /** Additive; absent from an API that predates the settings form. */
    settings?: EverIdAdminSettings;
}

export type { EverIdCheckId } from '@/lib/auth/ever-id';

/** One FR-3 check of `POST /admin/test` (the order is `EVER_ID_CHECK_IDS`). */
export interface EverIdCheck {
    id: EverIdCheckId;
    ok: boolean;
    detail?: string;
}

/** `GET /admin/health` — ISO timestamps, or `null` when it has not happened yet. */
export interface EverIdAdminHealth {
    discoveryRefreshedAt: string | null;
    jwksRefreshedAt: string | null;
    lastLogoutNoticeAt: string | null;
}

/** A refused or failed Ever ID call. Carries no upstream message text on purpose. */
export class EverIdRequestError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string | null,
        public readonly retryAfterSeconds: number | null = null,
        public readonly body: Record<string, unknown> | null = null,
    ) {
        super(`Ever ID request failed with status ${status}${code ? ` (${code})` : ''}`);
        this.name = 'EverIdRequestError';
    }
}

async function toRequestError(response: Response): Promise<EverIdRequestError> {
    let body: Record<string, unknown> | null = null;
    try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
        }
    } catch {
        body = null;
    }

    const nested =
        body?.error && typeof body.error === 'object'
            ? (body.error as Record<string, unknown>)
            : null;
    const code =
        typeof body?.code === 'string'
            ? body.code
            : typeof nested?.code === 'string'
              ? nested.code
              : null;
    const retryAfter =
        response.status === 429 ? toRetryAfterSeconds(response.headers.get('Retry-After')) : null;

    return new EverIdRequestError(response.status, code, retryAfter, body);
}

async function everIdRequest<T>(path: string, init: RequestInit): Promise<T> {
    const response = await serverFetch<Response>(`${BASE}${path}`, {
        ...init,
        rawResponse: true,
        publicRouteScope: 'personal',
    });

    if (!response.ok) {
        throw await toRequestError(response);
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
    return everIdRequest<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function get<T>(path: string): Promise<T> {
    return everIdRequest<T>(path, { method: 'GET' });
}

function patch<T>(path: string, body: unknown): Promise<T> {
    return everIdRequest<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export const everIdAPI = {
    /** Start a browser sign-in. `returnTo` must already be a validated relative path. */
    authorize: (body: { returnTo?: string }) => post<EverIdAuthorizeResponse>('/authorize', body),

    /** Finish the provider round trip (the web's callback route). */
    callback: (body: { code: string; state: string; iss?: string; transaction: string }) =>
        post<EverIdCallbackResult>('/callback', body),

    /** Create the account a pending sign-up describes, with the terms accepted for it. */
    confirmSignUp: (body: { pending: string; terms: TermsAcceptanceClaim[] }) =>
        post<EverIdSignUpResponse>('/sign-up/confirm', body),

    /** Start connecting Ever ID to the signed-in account (asks for a fresh sign-in). */
    connectAuthorize: () => post<EverIdAuthorizeResponse>('/connect/authorize'),

    /** Connect the identity a pending connection describes. */
    connectConfirm: (body: { pending: string }) => post<EverIdIdentity>('/connect/confirm', body),

    listIdentities: () => get<EverIdIdentityList>('/identities'),

    disconnect: (id: string) =>
        everIdRequest<void>(`/identities/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    /** `200` only when the CURRENT session was opened with Ever ID; `404` otherwise. */
    logoutUrl: () => get<EverIdLogoutUrlResponse>('/logout-url'),

    adminStatus: () => get<EverIdAdminStatus>('/admin/status'),
    adminTest: () => post<EverIdCheck[]>('/admin/test'),
    adminHealth: () => get<EverIdAdminHealth>('/admin/health'),
    adminEnable: () => post<EverIdAdminStatus>('/admin/enable'),
    adminDisable: () => post<EverIdAdminStatus>('/admin/disable'),
    /** Change the administrator-managed values; answers the new status. */
    adminSettings: (body: EverIdAdminSettingsPatch) =>
        patch<EverIdAdminStatus>('/admin/settings', body),
};

/** A failure reduced to the code the copy is keyed by (and the wait, for a rate limit). */
export interface EverIdFailure {
    code: EverIdFailureCode;
    retryAfterSeconds?: number;
}

/**
 * Classify anything an Ever ID call can throw.
 *
 * - `429` → `rate_limited`, with the `Retry-After` wait;
 * - a known wire code → that code;
 * - a `5xx`, a transport failure or an unreadable answer → `provider_unavailable`
 *   (S16: "Ever ID isn't responding … or sign in another way" — the advice is
 *   right whichever hop failed);
 * - any other refusal → `fallback` (the caller's best description of its step).
 */
export function toEverIdFailure(
    error: unknown,
    fallback: EverIdFailureCode = 'transaction_invalid',
): EverIdFailure {
    if (!(error instanceof EverIdRequestError)) {
        return { code: 'provider_unavailable' };
    }
    if (error.status === 429) {
        return {
            code: EVER_ID_RATE_LIMITED,
            retryAfterSeconds: error.retryAfterSeconds ?? toRetryAfterSeconds(null),
        };
    }
    if (isEverIdFailureCode(error.code)) {
        return { code: error.code };
    }
    if (error.status >= 500) {
        return { code: 'provider_unavailable' };
    }
    return { code: fallback };
}
