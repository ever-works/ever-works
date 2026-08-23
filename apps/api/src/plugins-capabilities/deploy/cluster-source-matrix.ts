/**
 * Deploy-target matrix presentation helpers.
 *
 * The security-sensitive cluster, token, and namespace rules live with the
 * authoritative deployment-context resolver in `@ever-works/agent/deployment-context`.
 * This API module re-exports those primitives so existing controllers and
 * tests keep their public import path while deploy and lookup cannot drift.
 */
import {
    isAdminOnlyOrg,
    isEverWorksSharedOrg,
    type ClusterSource,
} from '@ever-works/agent/deployment-context';

export {
    RESERVED_DEPLOY_NAMESPACES,
    isAdminOnlyOrg,
    isEverWorksSharedOrg,
    isReservedDeployNamespace,
    isSharedClusterSource,
    normalizeClusterSource,
    resolveKubeconfigForClusterSource,
    validateClusterSourceForOwner,
} from '@ever-works/agent/deployment-context';
export type {
    ClusterSource,
    ClusterSourceValidationFailure,
    LegacyClusterSource,
} from '@ever-works/agent/deployment-context';

/**
 * Allowed cluster sources for the caller, in UI order (first = recommended).
 * The deploy resolver remains the authoritative admission gate.
 */
export function allowedClusterSourcesFor(
    isPlatformAdmin: boolean,
    websiteOwner?: string,
): readonly ClusterSource[] {
    const out: ClusterSource[] = [];
    if (isPlatformAdmin && (websiteOwner === undefined || isAdminOnlyOrg(websiteOwner))) {
        out.push('k8s-works');
    }
    out.push('k8s-works-shared');
    if (websiteOwner === undefined || !isEverWorksSharedOrg(websiteOwner)) {
        out.push('custom-kubeconfig');
    }
    return out;
}

export const CLUSTER_SOURCE_LABELS: Readonly<Record<ClusterSource, string>> = {
    'k8s-works-shared': 'Ever Works shared customer cluster',
    'k8s-works': 'Ever Works internal cluster (admin only)',
    'custom-kubeconfig': 'Custom — paste your own kubeconfig',
};

export const CLUSTER_SOURCE_DESCRIPTIONS: Readonly<Record<ClusterSource, string>> = {
    'k8s-works-shared': 'Ever Works shared customer cluster.',
    'k8s-works':
        "Ever Works internal cluster (admin-only, requires the website repo to live in the 'ever-works' GitHub org).",
    'custom-kubeconfig': 'Paste your own kubeconfig below.',
};
