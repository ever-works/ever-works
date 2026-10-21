/**
 * Works-security lane (2026-10-18) — the App Works actions that need the Work's OWNER, and the
 * default-safe operator switches that decide it.
 *
 * An App Work's runtime secrets (every env value, the dependency credentials, the image pull
 * credential) are rendered into whichever cluster the App targets. So whoever can choose that
 * cluster can read every one of them, and whoever can delete the App's stored data can destroy it
 * for good. Editors keep every build, env and deploy action; these few are the owner's:
 *
 * | Switch (default)                          | While on                                                                 |
 * | ----------------------------------------- | ------------------------------------------------------------------------ |
 * | `APP_TARGET_CHANGE_REQUIRES_OWNER` (on)   | connecting a cluster / changing its context, changing the target or its  |
 * |                                           | namespace, confirming a cluster change, and the first deploy with a      |
 * |                                           | credential a non-owner saved need the owner in a signed-in session       |
 * | `APP_DATA_DELETE_OWNER_ONLY` (on)         | `remove` with `deleteData` and a dependency's Delete data need the owner |
 * |                                           | in a signed-in session                                                   |
 * | `APP_LICENSE_ATTEST_SESSION_ONLY` (on)    | a licence attestation needs a signed-in session (never an API key)       |
 *
 * Each is ON unless its value is exactly `false` (case-insensitive, trimmed): an unset, empty or
 * misspelt value can never turn a gate off. Read per call, so a changed value takes effect on the
 * next request after the process restarts with it.
 *
 * The functions here are pure (no I/O): the API controllers apply the owner + session refusals,
 * and the deploy preconditions read {@link clusterCredentialNeedsOwnerConfirmation} so a deploy
 * nobody pressed (a Build-triggered auto-deploy, the worker's own re-check) is refused too.
 */

import type { AppClusterCredentialProvenance } from '../entities/work-app-runtime-state.entity';

export const APP_TARGET_CHANGE_REQUIRES_OWNER_ENV = 'APP_TARGET_CHANGE_REQUIRES_OWNER';
export const APP_DATA_DELETE_OWNER_ONLY_ENV = 'APP_DATA_DELETE_OWNER_ONLY';
export const APP_LICENSE_ATTEST_SESSION_ONLY_ENV = 'APP_LICENSE_ATTEST_SESSION_ONLY';

type EnvLike = Record<string, string | undefined>;

/** ON unless the value is exactly `false` — a default-safe switch cannot fail open. */
function defaultOn(name: string, env: EnvLike | undefined): boolean {
    const raw = (env ?? process.env)[name];
    return String(raw ?? '').trim().toLowerCase() !== 'false';
}

/** `APP_TARGET_CHANGE_REQUIRES_OWNER` — see the module table. Default ON. */
export function appTargetChangeRequiresOwner(env?: EnvLike): boolean {
    return defaultOn(APP_TARGET_CHANGE_REQUIRES_OWNER_ENV, env);
}

/** `APP_DATA_DELETE_OWNER_ONLY` — see the module table. Default ON. */
export function appDataDeleteOwnerOnly(env?: EnvLike): boolean {
    return defaultOn(APP_DATA_DELETE_OWNER_ONLY_ENV, env);
}

/** `APP_LICENSE_ATTEST_SESSION_ONLY` — see the module table. Default ON. */
export function appLicenseAttestSessionOnly(env?: EnvLike): boolean {
    return defaultOn(APP_LICENSE_ATTEST_SESSION_ONLY_ENV, env);
}

/** The runtime-state fields {@link clusterCredentialNeedsOwnerConfirmation} reads. */
export interface ClusterCredentialStateView {
    target?: string | null;
    targetSettings?: { clusterCredential?: AppClusterCredentialProvenance | null } | null;
    /** The deployed cluster — set once a Deployment went live (plan §6.3). */
    clusterFingerprint?: string | null;
    currentDeploymentId?: string | null;
    /** A cluster check on record means a credential was stored at some point. */
    clusterCheck?: unknown;
}

/**
 * Whether the Work's your-cluster credential must be confirmed by the OWNER before it is used.
 *
 *  - not `your-cluster` → no (the managed tier's credential is the operator's);
 *  - provenance recorded (`POST app-target/check` writes it): yes when a non-owner saved it and
 *    the owner has not confirmed it since;
 *  - no provenance (a credential stored before provenance existed, or through another path): yes
 *    only for a Work that has never deployed and has a cluster check on record — a deployed Work
 *    is covered by the fingerprint comparison (`cluster_changed_unconfirmed`), and a Work with no
 *    check has no credential to confirm (its deploy is refused `target_not_checked` anyway).
 */
export function clusterCredentialNeedsOwnerConfirmation(
    state: ClusterCredentialStateView | null | undefined,
): boolean {
    if (!state || state.target !== 'your-cluster') return false;
    const provenance = state.targetSettings?.clusterCredential ?? null;
    if (provenance && typeof provenance === 'object') {
        if (provenance.ownerConfirmedAt) return false;
        return provenance.savedByOwner !== true;
    }
    const deployed = Boolean(state.clusterFingerprint) || Boolean(state.currentDeploymentId);
    const checked = state.clusterCheck !== null && state.clusterCheck !== undefined;
    return !deployed && checked;
}
