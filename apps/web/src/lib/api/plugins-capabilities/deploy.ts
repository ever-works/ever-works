import 'server-only';
import { serverFetch, serverMutation } from '../server-api';
import { APIResponse } from '../types';
import type { PluginIcon } from '@ever-works/plugin';

export type { PluginIcon };

export interface DeployProvider {
    id: string;
    name: string;
    enabled: boolean;
    configured?: boolean;
    icon?: PluginIcon;
    description?: string;
    homepage?: string;
}

export type DeployProvidersResponseDto = APIResponse<{
    providers: DeployProvider[];
}>;

export type ProviderConfiguredResponseDto = APIResponse<{
    configured: boolean;
    available: boolean;
    enabled?: boolean;
    message?: string;
}>;

export type ValidateDeployTokenDto = APIResponse<{
    valid: boolean;
    userInfo: any;
}>;

export type DeployWebsiteResponseDto = APIResponse<{
    slug: string;
    owner: string;
    repository: string;
    message: string;
}>;

export type DeploymentTeam = {
    id: string;
    slug: string;
    name: string | null;
    saml?: any;
    createdAt: number;
};

export type DeploymentTeamResponse = APIResponse<{
    teams: DeploymentTeam[];
}>;

export interface DeployWebsiteDto {
    teamScope?: string;
}

export type LookupDeploymentResponseDto = APIResponse<{
    website?: string;
    deploymentState?: string;
    found: boolean;
    message?: string;
}>;

export type DeploymentCapabilityResponseDto = APIResponse<{
    canDeploy: boolean;
    isShared: boolean;
    ownerHasToken: boolean;
    userHasToken: boolean;
}>;

export interface DeploymentDomainVerification {
    type: string;
    domain: string;
    value: string;
    reason: string;
}

export interface DeploymentDomain {
    name: string;
    verified: boolean;
    verification?: DeploymentDomainVerification[];
}

export type DomainsResponseDto = APIResponse<{
    domains: DeploymentDomain[];
}>;

export type AddDomainResponseDto = APIResponse<{
    domain: DeploymentDomain;
    verified: boolean;
}>;

export type RemoveDomainResponseDto = APIResponse<{
    removed: boolean;
}>;

export type VerifyDomainResponseDto = APIResponse<{
    domain: DeploymentDomain;
}>;

export interface RuntimeEnvState {
    databaseUrl: { configured: boolean; masked: string | null };
    /** Secrets auto-managed by the deploy feature (not user-editable). */
    managed: string[];
}

export type RuntimeEnvResponseDto = APIResponse<RuntimeEnvState>;

/**
 * EW-740 — per-Work managed subdomain ("Site URL / Subdomain") state surfaced
 * by `GET /api/deploy/works/:id/subdomain`. See `docs/specs/features/cloudflare-dns-plugin/spec.md`
 * section 4.5 ("Per-Work subdomain UI") for the contract.
 *
 * - `subdomain` — bare label (e.g. `acme`); `null` when no managed subdomain
 *   has been allocated yet (Work hasn't deployed on a managed-subdomain provider).
 * - `fqdn` — fully-qualified hostname (e.g. `acme.ever.works`); `null` when
 *   `subdomain` is `null`.
 * - `url` — full `https://${fqdn}` for direct linking; `null` when `fqdn` is `null`.
 * - `recordOk` — DNS record exists and points at the expected target. When
 *   `false` the UI should avoid presenting the URL as a verified live link.
 * - `editable` — `true` when the user is allowed to change the subdomain
 *   (owner/editor with a managed-subdomain provider). When `false` the UI
 *   shows the value read-only.
 */
export interface SubdomainState {
    subdomain: string | null;
    fqdn: string | null;
    url: string | null;
    recordOk: boolean;
    editable: boolean;
}

export type SubdomainResponseDto = APIResponse<SubdomainState>;

/**
 * One selectable Kubernetes `clusterSource` option, as returned by
 * `GET /api/deploy/cluster-sources`. `label`/`description` are human copy;
 * the admin-only `k8s-works` option is omitted server-side for non-admins.
 */
export interface ClusterSourceOption {
    value: string;
    label: string;
    description?: string;
}

export type ClusterSourcesResponseDto = APIResponse<{
    clusterSources: ClusterSourceOption[];
}>;

export const deployAPI = {
    // Get available deployment providers
    getProviders: async () => {
        return serverFetch<DeployProvidersResponseDto>('/deploy/providers');
    },

    // List the k8s clusterSource options the current user may select
    // (admin-filtered server-side).
    getClusterSources: async () => {
        return serverFetch<ClusterSourcesResponseDto>('/deploy/cluster-sources');
    },

    // Check if a provider is configured for the current user
    isProviderConfigured: async (providerId: string) => {
        return serverFetch<ProviderConfiguredResponseDto>(
            `/deploy/providers/${providerId}/configured`,
        );
    },

    // Deploy work to its configured provider
    deploy: async (workId: string, data: DeployWebsiteDto) => {
        return serverMutation<DeployWebsiteResponseDto>({
            // Security: encode workId to prevent path-segment injection
            endpoint: `/deploy/works/${encodeURIComponent(workId)}`,
            data: { teamScope: data.teamScope },
            method: 'POST',
            wrapInData: false,
        });
    },

    // Validate deployment token
    validateToken: (token: string) => {
        return serverMutation<ValidateDeployTokenDto>({
            endpoint: '/deploy/validate-token',
            data: { token },
            method: 'POST',
            wrapInData: false,
        });
    },

    // Get deployment teams (requires work context for token)
    getDeploymentTeams() {
        return serverMutation<DeploymentTeamResponse>({
            endpoint: '/deploy/teams',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Get teams for a specific work
    getTeamsForWork(workId: string) {
        return serverMutation<DeploymentTeamResponse>({
            // Security: encode workId to prevent path-segment injection
            endpoint: `/deploy/works/${encodeURIComponent(workId)}/teams`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    lookupExistingDeployment(workId: string, data?: DeployWebsiteDto) {
        return serverMutation<LookupDeploymentResponseDto>({
            // Security: encode workId to prevent path-segment injection
            endpoint: `/deploy/works/${encodeURIComponent(workId)}/lookup`,
            data: data ? { teamScope: data.teamScope } : {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Check if deployment is possible for a work.
     */
    checkDeploymentCapability(workId: string) {
        return serverMutation<DeploymentCapabilityResponseDto>({
            // Security: encode workId to prevent path-segment injection
            endpoint: `/deploy/works/${encodeURIComponent(workId)}/check`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Get domains for a deployed work
     */
    getDomains(workId: string) {
        // Security: encode workId to prevent path-segment injection
        return serverFetch<DomainsResponseDto>(
            `/deploy/works/${encodeURIComponent(workId)}/domains`,
        );
    },

    /**
     * Add a domain to a deployed work
     */
    addDomain(workId: string, domain: string) {
        return serverMutation<AddDomainResponseDto>({
            // Security: encode workId to prevent path-segment injection
            endpoint: `/deploy/works/${encodeURIComponent(workId)}/domains`,
            data: { domain },
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Get the per-Work runtime env (masked DATABASE_URL + auto-managed secrets)
     */
    getRuntimeEnv(workId: string) {
        return serverFetch<RuntimeEnvResponseDto>(
            // Security: encode workId to prevent path-segment injection
            `/deploy/works/${encodeURIComponent(workId)}/runtime-env`,
        );
    },

    /**
     * Set the per-Work DATABASE_URL (applied on next deploy)
     */
    setRuntimeEnv(workId: string, databaseUrl: string) {
        return serverMutation<RuntimeEnvResponseDto>({
            // Security: encode workId to prevent path-segment injection
            endpoint: `/deploy/works/${encodeURIComponent(workId)}/runtime-env`,
            data: { databaseUrl },
            method: 'PUT',
            wrapInData: false,
        });
    },

    /**
     * EW-740 — get the per-Work managed subdomain state (label, fqdn, url,
     * recordOk, editable). Returns nullable fields when no managed subdomain
     * has been allocated.
     */
    getSubdomain(workId: string) {
        // Security: encode workId to prevent path-segment injection
        return serverFetch<SubdomainResponseDto>(
            `/deploy/works/${encodeURIComponent(workId)}/subdomain`,
        );
    },

    /**
     * EW-740 — set the per-Work managed subdomain. The API validates the
     * subdomain format (`SLUG_RE`) and uniqueness, allocates a DNS record,
     * and returns the updated `SubdomainState`.
     */
    setSubdomain(workId: string, subdomain: string) {
        return serverMutation<SubdomainResponseDto>({
            endpoint: `/deploy/works/${encodeURIComponent(workId)}/subdomain`,
            data: { subdomain },
            method: 'PUT',
            wrapInData: false,
        });
    },

    /**
     * Remove a domain from a deployed work
     */
    removeDomain(workId: string, domain: string) {
        return serverMutation<RemoveDomainResponseDto>({
            endpoint: `/deploy/works/${encodeURIComponent(workId)}/domains/${encodeURIComponent(domain)}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /**
     * Verify a domain on a deployed work
     */
    verifyDomain(workId: string, domain: string) {
        return serverMutation<VerifyDomainResponseDto>({
            // Security: encode workId to prevent path-segment injection (domain was already encoded)
            endpoint: `/deploy/works/${encodeURIComponent(workId)}/domains/${encodeURIComponent(domain)}/verify`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
