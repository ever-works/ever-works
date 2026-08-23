import type { DeploymentLookupContext, SettingSource } from '@ever-works/plugin';
import { buildEverWorksTenantNamespace } from '../ever-works-providers/ever-works-k8s-deploy.provider';

export const PLATFORM_MANAGED_KUBECONFIG_SENTINEL = '__ever-works-platform-managed-kubeconfig__';

export type ClusterSource = 'k8s-works' | 'k8s-works-shared' | 'custom-kubeconfig';
export type LegacyClusterSource = 'k8s-gauzy';

export interface ClusterSourceValidationFailure {
    readonly code:
        | 'K8S_WORKS_NOT_ALLOWED'
        | 'CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG'
        | 'CUSTOM_KUBECONFIG_MISSING_KUBECONFIG';
    readonly message: string;
}

export type DeploymentContextResolutionErrorCode =
    | 'DEPLOY_MATRIX_VIOLATION'
    | 'PLATFORM_KUBECONFIG_MISSING'
    | 'RESERVED_NAMESPACE';

export class DeploymentContextResolutionError extends Error {
    constructor(
        message: string,
        readonly code: DeploymentContextResolutionErrorCode,
        readonly reason?: string,
    ) {
        super(message);
        this.name = 'DeploymentContextResolutionError';
    }
}

export interface EffectiveDeploymentContextInput {
    readonly deployProvider?: string;
    readonly pluginId?: string;
    readonly resolvedToken: string;
    readonly settings: Record<string, unknown>;
    readonly settingSources?: Readonly<Record<string, SettingSource | undefined>>;
    readonly websiteOwner: string;
    readonly websiteProjectName?: string;
    readonly workId: string;
    readonly workSlug?: string | null;
    readonly ownerUserId?: string | null;
    readonly isPlatformAdmin?: boolean;
    readonly env?: NodeJS.ProcessEnv;
}

export interface EffectiveDeploymentContext {
    readonly token: string;
    readonly settings: Record<string, unknown>;
    readonly namespace?: string;
    readonly clusterSource?: ClusterSource;
    readonly lookupContext?: DeploymentLookupContext;
}

const KUBERNETES_DEPLOY_PROVIDER_ID = 'k8s';
const EVER_WORKS_DEPLOY_PROVIDER_ID = 'ever-works';
const EVER_WORKS_SHARED_ORGS = new Set(['ever-works', 'ever-works-cloud']);

export function normalizeClusterSource(value: string): ClusterSource | undefined {
    if (value === 'k8s-works' || value === 'k8s-works-shared' || value === 'custom-kubeconfig') {
        return value;
    }
    return value === 'k8s-gauzy' ? 'k8s-works' : undefined;
}

export function coerceDeploymentClusterSource(value: unknown): ClusterSource {
    if (typeof value === 'string') {
        const normalized = normalizeClusterSource(value);
        if (normalized) return normalized;
    }
    return 'custom-kubeconfig';
}

export function isEverWorksSharedOrg(websiteOwner: string): boolean {
    return EVER_WORKS_SHARED_ORGS.has(websiteOwner.trim().toLowerCase());
}

export function isAdminOnlyOrg(websiteOwner: string): boolean {
    return websiteOwner.trim().toLowerCase() === 'ever-works';
}

export function validateClusterSourceForOwner(
    websiteOwner: string,
    clusterSource: ClusterSource,
    options: { hasKubeconfig?: boolean; isPlatformAdmin?: boolean } = {},
): ClusterSourceValidationFailure | null {
    const source = normalizeClusterSource(clusterSource) ?? clusterSource;
    const isPlatformAdmin = options.isPlatformAdmin ?? false;
    const hasKubeconfig = options.hasKubeconfig ?? true;

    if (source === 'k8s-works' && (!isPlatformAdmin || !isAdminOnlyOrg(websiteOwner))) {
        const message = !isPlatformAdmin
            ? `'k8s-works' is the Ever Works internal cluster and is restricted to platform admins. ` +
              `Pick 'k8s-works-shared' (the shared customer cluster) instead.`
            : `'k8s-works' is the Ever Works internal cluster and requires the website repo to live in ` +
              `the 'ever-works' GitHub org. The website repo for this Work is in '${websiteOwner}'. ` +
              `Pick 'k8s-works-shared' instead, or move the Work to the 'ever-works' org.`;
        return { code: 'K8S_WORKS_NOT_ALLOWED', message };
    }

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

export const RESERVED_DEPLOY_NAMESPACES: ReadonlySet<string> = new Set([
    'ever-works',
    'kube-system',
    'kube-public',
    'kube-node-lease',
    'default',
    'argocd',
    'cert-manager',
    'ingress-nginx',
    'monitoring',
]);

export function isReservedDeployNamespace(namespace: string): boolean {
    const normalized = namespace.trim().toLowerCase();
    return Boolean(
        normalized &&
        (RESERVED_DEPLOY_NAMESPACES.has(normalized) || normalized.startsWith('kube-')),
    );
}

export function isSharedClusterSource(clusterSource: ClusterSource): boolean {
    const source = normalizeClusterSource(clusterSource) ?? clusterSource;
    return source === 'k8s-works-shared' || source.includes('shared');
}

export function resolveEffectiveDeploymentContext(
    input: EffectiveDeploymentContextInput,
): EffectiveDeploymentContext {
    const isKubernetes =
        input.deployProvider === KUBERNETES_DEPLOY_PROVIDER_ID ||
        input.deployProvider === EVER_WORKS_DEPLOY_PROVIDER_ID ||
        input.pluginId === KUBERNETES_DEPLOY_PROVIDER_ID;
    if (!isKubernetes) {
        return { token: input.resolvedToken, settings: input.settings };
    }

    const managedAlias = input.deployProvider === EVER_WORKS_DEPLOY_PROVIDER_ID;
    const clusterSource = coerceDeploymentClusterSource(input.settings.clusterSource);
    const realUserToken =
        input.resolvedToken === PLATFORM_MANAGED_KUBECONFIG_SENTINEL ? '' : input.resolvedToken;

    let token = realUserToken;
    if (!managedAlias) {
        const failure = validateClusterSourceForOwner(input.websiteOwner, clusterSource, {
            hasKubeconfig: Boolean(realUserToken.trim()),
            isPlatformAdmin: input.isPlatformAdmin,
        });
        if (failure) {
            throw new DeploymentContextResolutionError(
                failure.message,
                'DEPLOY_MATRIX_VIOLATION',
                failure.code,
            );
        }
        try {
            token = resolveKubeconfigForClusterSource(
                clusterSource,
                realUserToken,
                input.env ?? process.env,
            );
        } catch (error) {
            throw new DeploymentContextResolutionError(
                error instanceof Error ? error.message : String(error),
                'PLATFORM_KUBECONFIG_MISSING',
            );
        }
    }

    const settings = { ...input.settings };
    const usesManagedKubeconfig = managedAlias || clusterSource !== 'custom-kubeconfig';
    const requestedKubeContext =
        typeof input.settings.kubeContext === 'string' && input.settings.kubeContext.trim()
            ? input.settings.kubeContext
            : null;
    if (usesManagedKubeconfig) {
        // Cluster credentials and their selected context are one trust unit.
        // A tenant-saved context is meaningful only inside that tenant's
        // custom kubeconfig; managed kubeconfigs must use their operator-owned
        // current context instead of inheriting a stale/foreign tenant value.
        delete settings.kubeContext;
    }
    const requestedNamespace =
        typeof input.settings.namespace === 'string' ? input.settings.namespace.trim() : '';
    const namespaceSource = input.settingSources?.namespace;
    const namespaceIsExplicit =
        namespaceSource === undefined ? Boolean(requestedNamespace) : namespaceSource !== 'default';
    let namespace: string | undefined;

    if (managedAlias || isSharedClusterSource(clusterSource)) {
        const tenantId = input.ownerUserId?.trim() || input.workId;
        const base =
            (input.env ?? process.env).EVER_WORKS_DEPLOY_NAMESPACE?.trim() || 'ever-works-tenants';
        namespace = buildEverWorksTenantNamespace(tenantId, base);
    } else if (requestedNamespace && namespaceIsExplicit) {
        if (isReservedDeployNamespace(requestedNamespace)) {
            throw new DeploymentContextResolutionError(
                `Namespace '${requestedNamespace}' is reserved and cannot be used as a deploy target. ` +
                    `Choose a different namespace (reserved: ever-works, default, kube-*, argocd, ` +
                    `cert-manager, ingress-nginx, monitoring).`,
                'RESERVED_NAMESPACE',
            );
        }
        namespace = requestedNamespace;
    } else if (clusterSource === 'k8s-works') {
        const slug = (input.workSlug || input.workId)
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40);
        const derived = slug ? `ever-works-${slug}-prod` : '';
        if (derived && !isReservedDeployNamespace(derived)) {
            namespace = derived;
        }
    } else if (requestedNamespace) {
        // The Kubernetes plugin's documented custom-cluster default is the
        // legacy `ever-works` namespace. A schema default is not a user request
        // for a reserved platform namespace, so preserve it for BYOC Works.
        namespace = requestedNamespace;
    }

    if (namespace !== undefined) {
        settings.namespace = namespace;
    }

    return {
        token,
        settings,
        namespace,
        clusterSource,
        lookupContext: {
            settingsOverride: settings,
            namespaceOverride: namespace,
            projectNameOverride: input.websiteProjectName,
            kubeContextOverride: usesManagedKubeconfig ? null : requestedKubeContext,
        },
    };
}
