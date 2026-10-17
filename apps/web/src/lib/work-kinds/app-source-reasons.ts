/**
 * APW-01 T21 — App-source reason code ⇒ i18n key, and the parameters each
 * reason's copy interpolates (spec §6.3, the 24 rows in table order).
 *
 * Deliberately dependency-light and free of `'use client'` / `server-only`, so
 * the create form (client), its preview card and the server action that relays
 * an API refusal can all import the ONE map. A code that is not in the closed
 * {@link APP_SOURCE_REASON_CODES} set never gets a key: the caller falls back to
 * the generic "couldn't create" copy rather than rendering an unknown code.
 */

import {
    APP_SOURCE_REASON_CODES,
    isAppSourceReasonCode,
    type AppSourceReasonCode,
} from '@ever-works/contracts';

/** The namespace every reason key lives under (`en.json`). */
export const APP_SOURCE_REASON_NAMESPACE = 'dashboard.workCreation.app.reasons';

/**
 * Reason code ⇒ the leaf key under {@link APP_SOURCE_REASON_NAMESPACE}.
 *
 * The leaf is the code itself, written out per code on purpose: a `Record`
 * over the closed union makes a new code without copy a compile error, and the
 * unit spec proves every leaf exists in `en.json`.
 */
export const APP_SOURCE_REASON_KEYS: Readonly<Record<AppSourceReasonCode, AppSourceReasonCode>> = {
    invalid_url: 'invalid_url',
    provider_not_connected: 'provider_not_connected',
    insufficient_scope: 'insufficient_scope',
    not_found: 'not_found',
    sso_authorization_required: 'sso_authorization_required',
    oauth_app_restricted: 'oauth_app_restricted',
    empty_repository: 'empty_repository',
    no_push_access: 'no_push_access',
    archived: 'archived',
    forking_disabled: 'forking_disabled',
    own_repository: 'own_repository',
    target_owner_unavailable: 'target_owner_unavailable',
    target_owner_forbidden: 'target_owner_forbidden',
    too_large_for_private_copy: 'too_large_for_private_copy',
    uses_lfs: 'uses_lfs',
    copy_name_unavailable: 'copy_name_unavailable',
    in_use_by_another_account: 'in_use_by_another_account',
    app_work_exists: 'app_work_exists',
    create_in_progress: 'create_in_progress',
    rate_limited: 'rate_limited',
    managed_hosting_unavailable: 'managed_hosting_unavailable',
    cluster_target_unavailable: 'cluster_target_unavailable',
    app_works_disabled: 'app_works_disabled',
    blueprint_mismatch: 'blueprint_mismatch',
};

/** The full i18n key (`<namespace>.<leaf>`) for a reason, or `null` for an unknown code. */
export function appSourceReasonKey(code: unknown): string | null {
    if (!isAppSourceReasonCode(code)) return null;
    return `${APP_SOURCE_REASON_NAMESPACE}.${APP_SOURCE_REASON_KEYS[code]}`;
}

/** Every placeholder any §6.3 row interpolates. */
// A type alias, not an interface: next-intl's `values` parameter is an index
// signature, which an interface does not satisfy implicitly.
export type AppSourceReasonParams = {
    owner: string;
    size: string;
    name: string;
    fullName: string;
    workName: string;
    time: string;
};

/**
 * Format a KB size the way the preview shows it (`512 MB`, `1.2 GB`).
 * GitHub reports repository size in KB.
 */
export function formatRepositorySizeKb(sizeKb: number | null | undefined): string {
    if (typeof sizeKb !== 'number' || !Number.isFinite(sizeKb) || sizeKb < 0) return '—';
    const mb = sizeKb / 1024;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    if (mb >= 10) return `${Math.round(mb)} MB`;
    return `${mb.toFixed(1)} MB`;
}

/**
 * Every parameter, always present.
 *
 * next-intl refuses to format a message with a missing argument (it reports
 * the error and renders the key), so each reason is given the whole set and
 * picks what it needs. Unknown values fall back to a neutral `—` rather than an
 * empty string, which would read as a sentence with a hole in it.
 */
export function appSourceReasonParams(
    partial: Partial<AppSourceReasonParams> = {},
): AppSourceReasonParams {
    const pick = (value: string | undefined) => (value && value.trim().length > 0 ? value : '—');
    return {
        owner: pick(partial.owner),
        size: pick(partial.size),
        name: pick(partial.name),
        fullName: pick(partial.fullName),
        workName: pick(partial.workName),
        time: pick(partial.time),
    };
}

/** Re-exported so a caller iterating the codes reads them from one import. */
export { APP_SOURCE_REASON_CODES };
