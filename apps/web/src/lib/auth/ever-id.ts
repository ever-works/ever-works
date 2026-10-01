import {
    EVER_ID_ERROR_CODE_WIRE_VALUES,
    EVER_ID_LIMITS,
    EVER_ID_WIRE_ERROR_CODES,
    type EverIdErrorCode,
    type EverIdWireErrorCode,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { isValidRedirectUrl } from '@/lib/utils/url';

/**
 * APW-12 (Ever ID) — the web's vocabulary for the sign-in flow, shared by the
 * server actions, the callback and sign-out routes, the pages and the client
 * components.
 *
 * Nothing here reads a cookie or holds a secret. It is the closed set of values
 * the flow may put in an address — error codes and fixed markers, never a token,
 * code, `state` or e-mail address (spec FR-16, NFR-9) — and the one mapping from
 * those codes to copy.
 */

/**
 * A `429` from the throttler carries no Ever ID code of its own, so the web names
 * it. Copy: `auth.error.everId.rateLimited`.
 */
export const EVER_ID_RATE_LIMITED = 'rate_limited';

/** Every failure the flow can report: a wire code (CONTRACTS §12) or a rate limit. */
export type EverIdFailureCode = EverIdWireErrorCode | typeof EVER_ID_RATE_LIMITED;

/** The `auth.error.everId.*` leaf a failure renders. */
export type EverIdMessageKey = EverIdErrorCode | 'rateLimited';

/** `?error=` prefix the auth error page maps to `auth.error.everId.*`. */
export const EVER_ID_ERROR_PREFIX = 'ever_id_';

/** Query parameter carrying a rate limit's wait, in whole seconds. */
export const EVER_ID_RETRY_AFTER_PARAM = 'retryAfter';

/** Query parameter the Security page reads to show a toast after a redirect. */
export const EVER_ID_NOTICE_PARAM = 'everId';

/** The one non-error notice on the Security page: a connection completed. */
export const EVER_ID_CONNECTED_NOTICE = 'connected';

/** Marker on the sign-in page after "Also sign out of Ever ID" came back (S7). */
export const EVER_ID_SIGNED_OUT_PARAM = 'signedOut';
export const EVER_ID_SIGNED_OUT_VALUE = 'ever-id';

/** What the Security page can be asked to announce. */
export type EverIdSecurityNotice = EverIdFailureCode | typeof EVER_ID_CONNECTED_NOTICE;

/** A rate limit's wait when the API sent none (or one that makes no sense). */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3_600;

const KEY_BY_WIRE_CODE: ReadonlyMap<string, EverIdErrorCode> = new Map(
    (Object.entries(EVER_ID_ERROR_CODE_WIRE_VALUES) as Array<[EverIdErrorCode, string]>).map(
        ([key, wire]) => [wire, key],
    ),
);

const FAILURE_CODES: ReadonlySet<string> = new Set<string>([
    ...EVER_ID_WIRE_ERROR_CODES,
    EVER_ID_RATE_LIMITED,
]);

/** Whether `value` is one of the failure codes the flow is allowed to report. */
export function isEverIdFailureCode(value: unknown): value is EverIdFailureCode {
    return typeof value === 'string' && FAILURE_CODES.has(value);
}

/**
 * The `auth.error.everId.*` leaf for a wire code (`ever_id_disabled` →
 * `everIdDisabled`) or the rate limit. `null` for anything outside the closed set,
 * so a caller can never render a key built from untrusted input.
 */
export function everIdMessageKey(code: string | null | undefined): EverIdMessageKey | null {
    if (!code) return null;
    if (code === EVER_ID_RATE_LIMITED) return 'rateLimited';
    return KEY_BY_WIRE_CODE.get(code) ?? null;
}

/**
 * A `Retry-After` (or `?retryAfter=`) value as whole seconds in `[1, 3600]`.
 * Anything absent, non-numeric or out of range becomes 60 — the copy must always
 * have a number to show.
 */
export function toRetryAfterSeconds(value: string | number | null | undefined): number {
    const seconds = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(seconds) || seconds < 1) return DEFAULT_RETRY_AFTER_SECONDS;
    return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
}

function withQuery(path: string, params: Record<string, string>): string {
    return `${path}?${new URLSearchParams(params).toString()}`;
}

/**
 * Where a failed browser sign-in goes: the auth error page with
 * `?error=ever_id_<code>` (and the wait, for a rate limit). Codes only.
 */
export function everIdErrorPageHref(code: EverIdFailureCode, retryAfterSeconds?: number): string {
    const params: Record<string, string> = { error: `${EVER_ID_ERROR_PREFIX}${code}` };
    if (code === EVER_ID_RATE_LIMITED) {
        params[EVER_ID_RETRY_AFTER_PARAM] = String(toRetryAfterSeconds(retryAfterSeconds));
    }
    return withQuery(ROUTES.AUTH_ERROR, params);
}

/**
 * Where a connect attempt reports back: Settings → Security with `?everId=<code>`
 * (or `connected`), which the page turns into a toast.
 */
export function everIdSecurityNoticeHref(
    notice: EverIdSecurityNotice,
    retryAfterSeconds?: number,
): string {
    const params: Record<string, string> = { [EVER_ID_NOTICE_PARAM]: notice };
    if (notice === EVER_ID_RATE_LIMITED) {
        params[EVER_ID_RETRY_AFTER_PARAM] = String(toRetryAfterSeconds(retryAfterSeconds));
    }
    return withQuery(ROUTES.DASHBOARD_SETTINGS_SECURITY, params);
}

/** The failure code in an `?error=ever_id_<code>` value, or `null`. */
export function everIdCodeFromErrorParam(
    value: string | null | undefined,
): EverIdFailureCode | null {
    if (!value || !value.startsWith(EVER_ID_ERROR_PREFIX)) return null;
    const code = value.slice(EVER_ID_ERROR_PREFIX.length);
    return isEverIdFailureCode(code) ? code : null;
}

/** The notice in a Security page `?everId=` value, or `null` for anything else. */
export function toEverIdSecurityNotice(value: unknown): EverIdSecurityNotice | null {
    if (value === EVER_ID_CONNECTED_NOTICE) return EVER_ID_CONNECTED_NOTICE;
    return isEverIdFailureCode(value) ? value : null;
}

/**
 * The FR-3 checks **Test connection** reports, in the order the administrator
 * surface lists them (one row per id, spec §6.7).
 */
export const EVER_ID_CHECK_IDS = [
    'discovery',
    'issuerMatch',
    'endpoints',
    'pkceS256',
    'signingAlg',
    'backchannelLogout',
    'deviceAuthorization',
] as const;

export type EverIdCheckId = (typeof EVER_ID_CHECK_IDS)[number];

/**
 * The longest return path the web forwards to the API.
 *
 * The API accepts up to 2,048 characters, but the path travels inside two sealed
 * values (the API's transaction and pending values) and the pending value then
 * travels inside the web's own encrypted cookie. Keeping the path short keeps
 * every cookie of the flow well inside a browser's 4 KB limit; a longer path —
 * never a real in-app address — falls back to the dashboard, as an invalid one
 * does (spec FR-10, ACC-12-12).
 */
export const EVER_ID_RETURN_TO_MAX_LENGTH = 512;

/**
 * A same-site relative return path, or `undefined`.
 *
 * The rule `isValidRedirectUrl` applies to relative URLs (a single leading `/`,
 * no `//` or `/\`, URL-safe characters only), restricted to relative paths: an
 * absolute URL is refused here even when its host is allow-listed, so this flow
 * can never become a hand-off to another origin.
 */
export function toEverIdReturnTo(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const path = value.trim();
    if (
        path.length === 0 ||
        path.length > EVER_ID_RETURN_TO_MAX_LENGTH ||
        !path.startsWith('/') ||
        path.startsWith('//') ||
        path.startsWith('/\\') ||
        !isValidRedirectUrl(path)
    ) {
        return undefined;
    }
    return path;
}

/** The two kinds of terminal client an administrator can allow (FR-2, FR-39). */
export const EVER_ID_LOCAL_CLIENT_KINDS = ['cli', 'node'] as const;

export type EverIdLocalClientKind = (typeof EVER_ID_LOCAL_CLIENT_KINDS)[number];

/**
 * The bounds the API's settings endpoint (`PATCH /admin/settings`) enforces on
 * the administrator-managed values, so the form can state them up front and the
 * server action can refuse an impossible value before it travels. The API stays
 * the authority; the two list sizes are the contract's own limits.
 */
export const EVER_ID_ADMIN_SETTINGS_LIMITS = {
    displayNameMaxLength: 40,
    accountManagementUrlMaxLength: 2048,
    localClientsMax: EVER_ID_LIMITS.localClientsMax,
    clientIdMaxLength: 255,
    delegatedClientNamesMax: EVER_ID_LIMITS.delegatedClientNamesMax,
    delegatedDisplayNameMaxLength: 60,
} as const;

/** An `https://` address with no whitespace — the only form the API accepts. */
export const EVER_ID_HTTPS_URL_PATTERN = /^https:\/\/\S+$/;
