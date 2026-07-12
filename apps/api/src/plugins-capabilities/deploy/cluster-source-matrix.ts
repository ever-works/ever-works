/**
 * Deploy-target resolution matrix for the per-Work Kubernetes deploy path.
 *
 * Three inputs decide where a Work may be published:
 *
 *  - **isPlatformAdmin** — whether the deploying user is a platform admin
 *    (`User.isPlatformAdmin`).
 *  - **Website repo owner** (and therefore the GHCR namespace the image
 *    lives in): `ever-works`, `ever-works-cloud`, or customer-owned.
 *  - **Cluster source**: `k8s-works`, `k8s-works-shared`, `custom-kubeconfig`.
 *
 * Renamed from EW-616 (old `k8s-gauzy` → `k8s-works` internal, old
 * `k8s-works` → `k8s-works-shared` shared). See `normalizeClusterSource`
 * for the back-compat alias and the one-shot data migration
 * `*-RenameK8sClusterSource.ts` for the stored-value rewrite.
 *
 * Rules that combine to produce the supported set:
 *
 *  1. `k8s-works` (the Ever Works INTERNAL cluster) is admin-only. It
 *     requires BOTH `isPlatformAdmin` AND a website repo in the `ever-works`
 *     GitHub org. Real customers must never be able to deploy onto it, and a
 *     non-admin must never be able to select it (even via the API/CLI).
 *
 *  2. `custom-kubeconfig` cannot be combined with an Ever Works-shared GHCR
 *     namespace (`ever-works` or `ever-works-cloud`). The cluster would
 *     receive an org-scoped classic PAT as an `imagePullSecret`, and
 *     `kubectl get secret -o yaml` on the customer's cluster could recover it
 *     and read every GHCR image in that shared org. To use your own cluster
 *     you must also bring your own GitHub org.
 *
 *  3. `k8s-works-shared` (the Ever Works SHARED customer cluster) is the
 *     default and is allowed for every owner. Its cluster may not be
 *     provisioned yet — `resolveKubeconfigForClusterSource` fails with a
 *     clear "not yet available" error rather than crashing.
 *
 * The resulting supported combinations (admin gate applies only to `k8s-works`):
 *
 * | Website owner      | k8s-works                | k8s-works-shared | custom-kubeconfig |
 * | ------------------ | ------------------------ | ---------------- | ----------------- |
 * | `ever-works`       | OK (admin only)          | OK               | rejected (rule 2) |
 * | `ever-works-cloud` | rejected (rule 1)        | OK (default)     | rejected (rule 2) |
 * | customer-owned     | rejected (rule 1)        | OK (default)     | OK                |
 *
 * The full background is in the EW-615/EW-616 tickets and the
 * `EVER_WORKS_K8S_DEPLOY_TROUBLESHOOTING.md` runbook.
 */

export type ClusterSource = 'k8s-works' | 'k8s-works-shared' | 'custom-kubeconfig';

/**
 * Pre-rename value that may still appear in un-migrated rows or in-flight
 * requests during a rolling deploy. `k8s-gauzy` was the internal cluster and
 * maps to the renamed `k8s-works`.
 *
 * NOTE: the OTHER pre-rename value, the string `k8s-works`, is deliberately
 * NOT remapped here — after the rename it unambiguously means the internal
 * cluster. Genuine old-shared `k8s-works` rows are rewritten to
 * `k8s-works-shared` once, atomically, by the data migration; treating a
 * runtime `k8s-works` as "old shared" would silently break every admin
 * selection.
 */
export type LegacyClusterSource = 'k8s-gauzy';

const LEGACY_CLUSTER_SOURCE_ALIASES: Readonly<Record<LegacyClusterSource, ClusterSource>> = {
    'k8s-gauzy': 'k8s-works',
};

const EVER_WORKS_SHARED_ORGS = new Set(['ever-works', 'ever-works-cloud']);

export function isEverWorksSharedOrg(websiteOwner: string): boolean {
    return EVER_WORKS_SHARED_ORGS.has(websiteOwner.trim().toLowerCase());
}

export function isAdminOnlyOrg(websiteOwner: string): boolean {
    return websiteOwner.trim().toLowerCase() === 'ever-works';
}

/**
 * Normalise a stored/incoming cluster-source string to a canonical
 * `ClusterSource`, remapping the unambiguous legacy `k8s-gauzy` alias.
 * Returns `undefined` for anything unrecognised so callers can fall back to
 * their own default (`custom-kubeconfig` for the deploy path).
 */
export function normalizeClusterSource(value: string): ClusterSource | undefined {
    if (value === 'k8s-works' || value === 'k8s-works-shared' || value === 'custom-kubeconfig') {
        return value;
    }
    if (value === 'k8s-gauzy') {
        return LEGACY_CLUSTER_SOURCE_ALIASES['k8s-gauzy'];
    }
    return undefined;
}

/**
 * Allowed cluster sources for the caller, in the order they should appear in
 * the UI dropdown (first entry = recommended default). Drives the
 * `k8s-cluster-source` widget via `GET /api/deploy/cluster-sources`.
 *
 * `websiteOwner` is optional: the user-global plugin-settings page has no Work
 * context, so it filters on `isPlatformAdmin` alone. When a Work owner IS
 * known (a Work-scoped call), the same org rules the deploy gate enforces are
 * applied so the dropdown never offers a combination the deploy would reject.
 */
export function allowedClusterSourcesFor(
    isPlatformAdmin: boolean,
    websiteOwner?: string,
): readonly ClusterSource[] {
    const out: ClusterSource[] = [];
    // Internal cluster: platform admins only. When a specific Work owner is
    // known, additionally require the `ever-works` org (mirrors rule 1).
    if (isPlatformAdmin && (websiteOwner === undefined || isAdminOnlyOrg(websiteOwner))) {
        out.push('k8s-works');
    }
    // Shared customer cluster: the default, always offered.
    out.push('k8s-works-shared');
    // Custom kubeconfig: hidden for Ever Works-shared orgs (rule 2). Offered
    // when the owner is unknown (user-global settings page) or customer-owned.
    if (websiteOwner === undefined || !isEverWorksSharedOrg(websiteOwner)) {
        out.push('custom-kubeconfig');
    }
    return out;
}

/**
 * Human labels for the cluster-source dropdown. The raw enum values are opaque
 * (`k8s-works-shared`, …); the `k8s-cluster-source` widget renders these
 * instead. Kept next to the enum so a new value can't be added without a label.
 */
export const CLUSTER_SOURCE_LABELS: Readonly<Record<ClusterSource, string>> = {
    'k8s-works-shared': 'Ever Works shared customer cluster',
    'k8s-works': 'Ever Works internal cluster (admin only)',
    'custom-kubeconfig': 'Custom — paste your own kubeconfig',
};

/**
 * Per-option help text. Mirrors the owner-provided settings-page copy; the
 * `k8s-works` line is only ever sent to platform admins (a non-admin's allowed
 * list never includes `k8s-works`, so its description never reaches them).
 */
export const CLUSTER_SOURCE_DESCRIPTIONS: Readonly<Record<ClusterSource, string>> = {
    'k8s-works-shared': 'Ever Works shared customer cluster.',
    'k8s-works':
        "Ever Works internal cluster (admin-only, requires the website repo to live in the 'ever-works' GitHub org).",
    'custom-kubeconfig': 'Paste your own kubeconfig below.',
};

export interface ClusterSourceValidationFailure {
    readonly code:
        | 'K8S_WORKS_NOT_ALLOWED'
        | 'CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG'
        | 'CUSTOM_KUBECONFIG_MISSING_KUBECONFIG';
    readonly message: string;
}

/**
 * Validate a (websiteOwner, clusterSource) pair against the deploy matrix.
 * Returns a failure record when the pair is rejected, `null` otherwise. The
 * caller decides how to surface the failure (HTTP exception in the controller,
 * logger.error in batch flows, etc).
 *
 * Fails closed: `isPlatformAdmin` defaults to `false` and `hasKubeconfig`
 * defaults to `true` when the options are omitted. Pure / side-effect-free so
 * it can be unit-tested without DI.
 */
export function validateClusterSourceForOwner(
    websiteOwner: string,
    clusterSource: ClusterSource,
    options: { hasKubeconfig?: boolean; isPlatformAdmin?: boolean } = {},
): ClusterSourceValidationFailure | null {
    const source = normalizeClusterSource(clusterSource) ?? clusterSource;
    const isPlatformAdmin = options.isPlatformAdmin ?? false;
    const hasKubeconfig = options.hasKubeconfig ?? true;

    // Rule 1: `k8s-works` (internal cluster). BOTH gates required — platform
    // admin AND `ever-works` org. Fails closed.
    if (source === 'k8s-works' && (!isPlatformAdmin || !isAdminOnlyOrg(websiteOwner))) {
        const message = !isPlatformAdmin
            ? `'k8s-works' is the Ever Works internal cluster and is restricted to platform admins. ` +
              `Pick 'k8s-works-shared' (the shared customer cluster) instead.`
            : `'k8s-works' is the Ever Works internal cluster and requires the website repo to live in ` +
              `the 'ever-works' GitHub org. The website repo for this Work is in '${websiteOwner}'. ` +
              `Pick 'k8s-works-shared' instead, or move the Work to the 'ever-works' org.`;
        return { code: 'K8S_WORKS_NOT_ALLOWED', message };
    }

    // Rule 2: `custom-kubeconfig` vs Ever Works-shared org (cross-tenant PAT).
    if (source === 'custom-kubeconfig' && isEverWorksSharedOrg(websiteOwner)) {
        return {
            code: 'CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG',
            message:
                `Cannot deploy a Work in the '${websiteOwner}' organisation to a customer-provided cluster. ` +
                `The cluster's imagePullSecret would contain an org-scoped PAT that grants read access ` +
                `to every GHCR image in '${websiteOwner}' (cross-tenant exposure). ` +
                `To use your own cluster, move this Work to your own GitHub org first, ` +
                `or pick 'k8s-works-shared' as the target cluster.`,
        };
    }

    if (source === 'custom-kubeconfig' && !hasKubeconfig) {
        return {
            code: 'CUSTOM_KUBECONFIG_MISSING_KUBECONFIG',
            message:
                `Target cluster is 'custom-kubeconfig' but no kubeconfig is saved on the Kubernetes plugin. ` +
                `Paste a kubeconfig in plugin settings, or pick a platform-managed cluster.`,
        };
    }

    return null;
}

/**
 * Resolve the kubeconfig YAML to push as the workflow's `K8S_TOKEN` secret.
 * For platform-managed cluster sources this reads the right env var; for
 * `custom-kubeconfig` it returns the user-pasted token. Legacy `k8s-gauzy` is
 * normalised to `k8s-works` first.
 *
 *  - `k8s-works`         → `EVER_WORKS_K8S_WORKS_KUBECONFIG` (internal cluster)
 *  - `k8s-works-shared`  → `EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG` (shared
 *                          customer cluster — may not be provisioned yet)
 *
 * Throws when a platform-managed source is requested but the platform has not
 * provisioned the corresponding env var. The env-var lookup is injected so
 * unit tests can avoid touching `process.env` directly.
 */
export function resolveKubeconfigForClusterSource(
    clusterSource: ClusterSource,
    userKubeconfig: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const source = normalizeClusterSource(clusterSource) ?? clusterSource;

    if (source === 'k8s-works') {
        const value = env.EVER_WORKS_K8S_WORKS_KUBECONFIG;
        if (!value || !value.trim()) {
            throw new Error(
                "Cluster source is 'k8s-works' but EVER_WORKS_K8S_WORKS_KUBECONFIG is not configured on the platform.",
            );
        }
        return value;
    }
    if (source === 'k8s-works-shared') {
        const value = env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG;
        if (!value || !value.trim()) {
            // The shared customer cluster may not be provisioned yet. Surface a
            // clear, user-actionable message instead of a raw env-var error.
            throw new Error(
                "The Ever Works shared customer cluster ('k8s-works-shared') is not available yet: " +
                    'EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG is not configured on the platform. ' +
                    'Choose another target cluster, or try again once the shared cluster is provisioned.',
            );
        }
        return value;
    }
    return userKubeconfig;
}
