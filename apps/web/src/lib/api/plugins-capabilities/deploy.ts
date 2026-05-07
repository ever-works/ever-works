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

export const deployAPI = {
    // Get available deployment providers
    getProviders: async () => {
        return serverFetch<DeployProvidersResponseDto>('/deploy/providers');
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
            endpoint: `/deploy/works/${workId}`,
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
            endpoint: `/deploy/works/${workId}/teams`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    lookupExistingDeployment(workId: string, data?: DeployWebsiteDto) {
        return serverMutation<LookupDeploymentResponseDto>({
            endpoint: `/deploy/works/${workId}/lookup`,
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
            endpoint: `/deploy/works/${workId}/check`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Get domains for a deployed work
     */
    getDomains(workId: string) {
        return serverFetch<DomainsResponseDto>(`/deploy/works/${workId}/domains`);
    },

    /**
     * Add a domain to a deployed work
     */
    addDomain(workId: string, domain: string) {
        return serverMutation<AddDomainResponseDto>({
            endpoint: `/deploy/works/${workId}/domains`,
            data: { domain },
            method: 'POST',
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
            endpoint: `/deploy/works/${workId}/domains/${encodeURIComponent(domain)}/verify`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
