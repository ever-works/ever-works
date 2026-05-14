/**
 * EW-616 deploy matrix enforcement.
 *
 * Two independent dimensions:
 *
 *  - **Website repo owner** (and therefore the GHCR namespace the
 *    image lives in): `ever-works`, `ever-works-cloud`, or
 *    customer-owned.
 *  - **Cluster source**: `k8s-works`, `k8s-gauzy`, `custom-kubeconfig`.
 *
 * Two rules combine to produce the supported set:
 *
 *  1. `k8s-gauzy` is admin-only — restricted to Works whose website
 *     repo is in the `ever-works` GitHub org. This is the internal
 *     platform cluster; real customers must not be allowed to deploy
 *     onto it.
 *
 *  2. `custom-kubeconfig` cannot be combined with an Ever Works-shared
 *     GHCR namespace (`ever-works` or `ever-works-cloud`). The cluster
 *     would receive an org-scoped classic PAT as an `imagePullSecret`,
 *     and `kubectl get secret -o yaml` on the customer's cluster could
 *     recover it and use it to read every GHCR image in that shared
 *     org. To use your own cluster, you must also bring your own GitHub
 *     org so the credential only grants access to your own resources.
 *
 * The resulting 5 supported combinations:
 *
 * | Website owner            | k8s-works | k8s-gauzy        | custom-kubeconfig |
 * | ------------------------ | --------- | ---------------- | ----------------- |
 * | `ever-works`             | OK        | OK (admin path)  | rejected (rule 2) |
 * | `ever-works-cloud`       | OK        | rejected (rule 1)| rejected (rule 2) |
 * | customer-owned           | OK        | rejected (rule 1)| OK                |
 *
 * The full background is in the EW-615/EW-616 tickets and the
 * `EVER_WORKS_K8S_DEPLOY_TROUBLESHOOTING.md` runbook.
 */

export type ClusterSource = 'k8s-works' | 'k8s-gauzy' | 'custom-kubeconfig';

const EVER_WORKS_SHARED_ORGS = new Set(['ever-works', 'ever-works-cloud']);

export function isEverWorksSharedOrg(websiteOwner: string): boolean {
    return EVER_WORKS_SHARED_ORGS.has(websiteOwner.trim().toLowerCase());
}

export function isAdminOnlyOrg(websiteOwner: string): boolean {
    return websiteOwner.trim().toLowerCase() === 'ever-works';
}

/**
 * Allowed cluster sources for a given website-repo owner, in the order
 * they should appear in the UI dropdown. The first entry is the
 * recommended default. The UI's `x-widget: k8s-cluster-source` reads
 * this to drive the conditional dropdown.
 */
export function allowedClusterSourcesFor(websiteOwner: string): readonly ClusterSource[] {
    if (isAdminOnlyOrg(websiteOwner)) {
        return ['k8s-works', 'k8s-gauzy'];
    }
    if (isEverWorksSharedOrg(websiteOwner)) {
        return ['k8s-works'];
    }
    return ['custom-kubeconfig', 'k8s-works'];
}

export interface ClusterSourceValidationFailure {
    readonly code:
        | 'K8S_GAUZY_NOT_ALLOWED'
        | 'CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG'
        | 'CUSTOM_KUBECONFIG_MISSING_KUBECONFIG';
    readonly message: string;
}

/**
 * Validate a (websiteOwner, clusterSource) pair against the deploy
 * matrix. Returns a failure record when the pair is rejected,
 * `null` otherwise. The caller decides how to surface the failure
 * (HTTP exception in the controller, logger.error in batch flows, etc).
 *
 * Pure / side-effect-free so it can be unit-tested without DI.
 */
export function validateClusterSourceForOwner(
    websiteOwner: string,
    clusterSource: ClusterSource,
    options: { hasKubeconfig: boolean } = { hasKubeconfig: true },
): ClusterSourceValidationFailure | null {
    if (clusterSource === 'k8s-gauzy' && !isAdminOnlyOrg(websiteOwner)) {
        return {
            code: 'K8S_GAUZY_NOT_ALLOWED',
            message:
                `'k8s-gauzy' is the Ever Works internal platform cluster ` +
                `and is restricted to Works in the 'ever-works' GitHub org. ` +
                `The website repo for this Work is in '${websiteOwner}'. ` +
                `Pick 'k8s-works' instead, or move the Work to the 'ever-works' org.`,
        };
    }

    if (clusterSource === 'custom-kubeconfig' && isEverWorksSharedOrg(websiteOwner)) {
        return {
            code: 'CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG',
            message:
                `Cannot deploy a Work in the '${websiteOwner}' organisation to a customer-provided cluster. ` +
                `The cluster's imagePullSecret would contain an org-scoped PAT that grants read access ` +
                `to every GHCR image in '${websiteOwner}' (cross-tenant exposure). ` +
                `To use your own cluster, move this Work to your own GitHub org first, ` +
                `or pick 'k8s-works' as the target cluster.`,
        };
    }

    if (clusterSource === 'custom-kubeconfig' && !options.hasKubeconfig) {
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
 * Resolve the kubeconfig YAML to push as the workflow's `K8S_TOKEN`
 * secret. For platform-managed cluster sources, this reads the right
 * env var; for `custom-kubeconfig`, it returns the user-pasted token.
 *
 * Throws when a platform-managed source is requested but the platform
 * has not provisioned the corresponding env var (operator bug).
 *
 * The env-var lookup is injected so unit tests can avoid touching
 * `process.env` directly.
 */
export function resolveKubeconfigForClusterSource(
    clusterSource: ClusterSource,
    userKubeconfig: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    if (clusterSource === 'k8s-works') {
        const value = env.EVER_WORKS_K8S_WORKS_KUBECONFIG;
        if (!value || !value.trim()) {
            throw new Error(
                "Cluster source is 'k8s-works' but EVER_WORKS_K8S_WORKS_KUBECONFIG is not configured on the platform.",
            );
        }
        return value;
    }
    if (clusterSource === 'k8s-gauzy') {
        const value = env.EVER_WORKS_K8S_GAUZY_KUBECONFIG;
        if (!value || !value.trim()) {
            throw new Error(
                "Cluster source is 'k8s-gauzy' but EVER_WORKS_K8S_GAUZY_KUBECONFIG is not configured on the platform.",
            );
        }
        return value;
    }
    return userKubeconfig;
}
