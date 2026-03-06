import 'server-only';
import { serverFetch, serverMutation } from '../server-api';
import { APIResponse } from '../types';
import type { PluginIcon } from '@ever-works/plugin';

export type { PluginIcon };

export interface DeployProvider {
    id: string;
    name: string;
    enabled: boolean;
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

    // Deploy directory to its configured provider
    deploy: async (directoryId: string, data: DeployWebsiteDto) => {
        return serverMutation<DeployWebsiteResponseDto>({
            endpoint: `/deploy/directories/${directoryId}`,
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

    // Get deployment teams (requires directory context for token)
    getDeploymentTeams() {
        return serverMutation<DeploymentTeamResponse>({
            endpoint: '/deploy/teams',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Get teams for a specific directory
    getTeamsForDirectory(directoryId: string) {
        return serverMutation<DeploymentTeamResponse>({
            endpoint: `/deploy/directories/${directoryId}/teams`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    lookupExistingDeployment(directoryId: string, data?: DeployWebsiteDto) {
        return serverMutation<LookupDeploymentResponseDto>({
            endpoint: `/deploy/directories/${directoryId}/lookup`,
            data: data ? { teamScope: data.teamScope } : {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Check if deployment is possible for a directory.
     */
    checkDeploymentCapability(directoryId: string) {
        return serverMutation<DeploymentCapabilityResponseDto>({
            endpoint: `/deploy/directories/${directoryId}/check`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Get domains for a deployed directory
     */
    getDomains(directoryId: string) {
        return serverFetch<DomainsResponseDto>(`/deploy/directories/${directoryId}/domains`);
    },

    /**
     * Add a domain to a deployed directory
     */
    addDomain(directoryId: string, domain: string) {
        return serverMutation<AddDomainResponseDto>({
            endpoint: `/deploy/directories/${directoryId}/domains`,
            data: { domain },
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * Remove a domain from a deployed directory
     */
    removeDomain(directoryId: string, domain: string) {
        return serverMutation<RemoveDomainResponseDto>({
            endpoint: `/deploy/directories/${encodeURIComponent(directoryId)}/domains/${encodeURIComponent(domain)}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /**
     * Verify a domain on a deployed directory
     */
    verifyDomain(directoryId: string, domain: string) {
        return serverMutation<VerifyDomainResponseDto>({
            endpoint: `/deploy/directories/${directoryId}/domains/${encodeURIComponent(domain)}/verify`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
