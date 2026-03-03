import { Injectable, Logger } from '@nestjs/common';
import type {
    IDeploymentPlugin,
    IDeployFacade,
    DeployFacadeOptions,
    DeployFacadeTeam,
    DeployProviderInfo,
    DeploymentLookupResult,
    DeploymentDomain,
    AddDomainResult,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { OAuthTokenRepository } from '../database/repositories/oauth-token.repository';
import { GitFacadeService } from './git.facade';
import { FacadeError, NoProviderError, ProviderNotFoundError } from './base.facade';
import type { Directory } from '../entities/directory.entity';
import type { User } from '../entities/user.entity';

export class DeployFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'DeployFacadeError';
    }
}

export class NoDeployProviderError extends DeployFacadeError {
    constructor() {
        super('No deployment provider configured or available', 'getPlugin');
        this.name = 'NoDeployProviderError';
    }
}

export class DeployProviderNotFoundError extends DeployFacadeError {
    constructor(providerId: string) {
        super(`Deployment provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'DeployProviderNotFoundError';
    }
}

export class NoDeployCredentialsError extends DeployFacadeError {
    constructor(providerId: string, userId: string, providerName?: string) {
        const displayName = providerName || providerId;
        super(
            `No ${displayName} credentials configured. ` +
                `Please configure your ${displayName} token in Plugin Settings.`,
            'getCredentials',
            providerId,
        );
        this.name = 'NoDeployCredentialsError';
    }
}

export interface DeployFacadeFullOptions extends DeployFacadeOptions {
    /** Override the provider (instead of using directory.deployProvider) */
    providerOverride?: string;
}

/**
 * DeployFacadeService provides a unified interface for deployment operations.
 *
 * It resolves the deployment provider from directory.deployProvider and retrieves
 * credentials from plugin settings (user-scoped). This facade implements the
 * IDeployFacade interface from the plugin package.
 *
 * Key differences from other facades:
 * - Uses directory.deployProvider instead of capability-based resolution
 * - Tokens are always from plugin settings (user-required configuration mode)
 * - Coordinates with GitFacade for git operations during deployment
 */
@Injectable()
export class DeployFacadeService implements IDeployFacade {
    private readonly logger = new Logger(DeployFacadeService.name);
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.DEPLOYMENT;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
        private readonly directoryRepository: DirectoryRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly directoryPluginRepository?: DirectoryPluginRepository,
    ) {}

    /**
     * Check if deployment is configured for a directory
     */
    async isConfigured(options: DeployFacadeOptions): Promise<boolean> {
        try {
            const directory = await this.directoryRepository.findById(options.directoryId);
            if (!directory?.deployProvider) {
                return false;
            }

            const registered = this.registry.get(directory.deployProvider);
            if (!registered || registered.state !== 'loaded') {
                return false;
            }

            // Check if user has configured their token
            const token = await this.getTokenFromSettings(
                directory.deployProvider,
                options.userId,
                options.directoryId,
            );
            return !!token;
        } catch {
            return false;
        }
    }

    /**
     * Get list of available deployment providers
     */
    getAvailableProviders(): DeployProviderInfo[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IDeploymentPlugin).providerName || p.plugin.name,
            enabled: p.state === 'loaded',
            icon: p.manifest.icon,
            description: p.manifest.description,
            homepage: p.manifest.homepage,
        }));
    }

    /**
     * Validate the user's deployment token
     */
    async validateToken(options: DeployFacadeOptions): Promise<boolean> {
        try {
            const { plugin, token } = await this.resolvePluginAndToken(options);
            if (plugin.validateToken) {
                return plugin.validateToken(token);
            }
            // If no validation method, assume valid if token exists
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get teams/organizations available to the user
     */
    async getTeams(options: DeployFacadeOptions): Promise<DeployFacadeTeam[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.getTeams) {
            return plugin.getTeams(token);
        }
        return [];
    }

    /**
     * Initiate a deployment
     *
     * This method coordinates with GitFacade to set secrets and dispatch workflows.
     * The actual deployment is handled by GitHub Actions.
     */
    async deploy(
        config: { projectName: string; teamScope?: string },
        options: DeployFacadeOptions,
    ): Promise<boolean> {
        const { plugin, token, directory } = await this.resolvePluginAndTokenWithDirectory(options);
        const user = directory.user as User;

        // Get git token for repository operations
        const gitToken = await this.gitFacade.getAccessToken({
            userId: user.id,
            providerId: directory.gitProvider,
        });

        if (!gitToken) {
            throw new DeployFacadeError('Git provider token not available', 'deploy', plugin.id);
        }

        // The deployment is coordinated through the deploy module/service
        // This facade just returns the plugin and token for the controller to use
        // The actual deployment flow uses VercelService.deploy() which handles:
        // 1. Setting secrets on the repository
        // 2. Dispatching the deployment workflow
        // 3. Triggering the deployment verification

        // For now, we return true to indicate deployment can proceed
        // The actual deployment is handled by the DeployService in the API layer
        return true;
    }

    /**
     * Get status of a deployment
     */
    async getDeploymentStatus(
        deploymentId: string,
        options: DeployFacadeOptions,
    ): Promise<{ status: string; url?: string; error?: string }> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        const result = await plugin.getDeploymentStatus(deploymentId, token);
        return {
            status: result.status,
            url: result.url,
            error: result.error,
        };
    }

    /**
     * Lookup existing deployment for a directory
     */
    async lookupExistingDeployment(
        projectName: string,
        options: DeployFacadeOptions,
    ): Promise<DeploymentLookupResult> {
        try {
            const { plugin, token, directory } =
                await this.resolvePluginAndTokenWithDirectory(options);

            // Get team scope from settings
            const settings = await this.settingsService.getSettings(plugin.id, {
                userId: options.userId,
                directoryId: options.directoryId,
                includeSecrets: false,
            });
            const teamScope = settings.defaultTeamScope as string | undefined;

            if (plugin.lookupExistingDeployment) {
                const result = await plugin.lookupExistingDeployment(projectName, token, teamScope);

                // Update directory with deployment info if found
                if (result.found && (result.website || result.deploymentState)) {
                    await this.directoryRepository.update(directory.id, {
                        website: result.website ?? undefined,
                        deploymentState: result.deploymentState ?? directory.deploymentState,
                    });
                }

                return result;
            }

            return { found: false };
        } catch {
            return { found: false };
        }
    }

    /**
     * Get deployment token for a user/directory
     * (Used by the deploy service for setting repository secrets)
     */
    async getDeployToken(options: DeployFacadeOptions): Promise<string | null> {
        try {
            const directory = await this.directoryRepository.findById(options.directoryId);
            if (!directory?.deployProvider) {
                return null;
            }
            return this.getTokenFromSettings(
                directory.deployProvider,
                options.userId,
                options.directoryId,
            );
        } catch {
            return null;
        }
    }

    /**
     * Get the deployment provider for a directory
     */
    async getDirectoryProvider(directoryId: string): Promise<string | null> {
        const directory = await this.directoryRepository.findById(directoryId);
        return directory?.deployProvider ?? null;
    }

    /**
     * Set deployment provider for a directory
     */
    async setDirectoryProvider(directoryId: string, providerId: string): Promise<void> {
        await this.directoryRepository.update(directoryId, {
            deployProvider: providerId,
        });
    }

    /**
     * Get the resolved plugin and token for deployment operations
     * (Used by the deploy service/controller)
     */
    async getPluginAndToken(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        directory: Directory;
    }> {
        return this.resolvePluginAndTokenWithDirectory(options);
    }

    // Domain management methods

    /**
     * Get domains for a deployed directory
     */
    async getDomains(options: DeployFacadeOptions): Promise<DeploymentDomain[]> {
        const { plugin, token, directory } = await this.resolvePluginAndTokenWithDirectory(options);
        if (!plugin.getDomains) {
            throw new DeployFacadeError('Domain management is not supported by this provider', 'getDomains', plugin.id);
        }
        const projectId = await this.resolveProjectId(plugin, token, directory, options);
        const teamScope = await this.getTeamScope(plugin.id, options);
        return plugin.getDomains(projectId, token, teamScope);
    }

    /**
     * Add a domain to a deployed directory
     */
    async addDomain(domain: string, options: DeployFacadeOptions): Promise<AddDomainResult> {
        const { plugin, token, directory } = await this.resolvePluginAndTokenWithDirectory(options);
        if (!plugin.addDomain) {
            throw new DeployFacadeError('Domain management is not supported by this provider', 'addDomain', plugin.id);
        }
        const projectId = await this.resolveProjectId(plugin, token, directory, options);
        const teamScope = await this.getTeamScope(plugin.id, options);
        const result = await plugin.addDomain(projectId, domain, token, teamScope);

        // Update directory.website if verified immediately
        if (result.verified) {
            await this.directoryRepository.update(directory.id, {
                website: `https://${result.domain.name}`,
            });
        }

        return result;
    }

    /**
     * Remove a domain from a deployed directory
     */
    async removeDomain(domain: string, options: DeployFacadeOptions): Promise<boolean> {
        const { plugin, token, directory } = await this.resolvePluginAndTokenWithDirectory(options);
        if (!plugin.removeDomain) {
            throw new DeployFacadeError(
                'Domain management is not supported by this provider',
                'removeDomain',
                plugin.id,
            );
        }
        const projectId = await this.resolveProjectId(plugin, token, directory, options);
        const teamScope = await this.getTeamScope(plugin.id, options);
        const removed = await plugin.removeDomain(projectId, domain, token, teamScope);

        // If the removed domain was the current website URL, re-lookup to update
        if (removed && directory.website === `https://${domain}`) {
            const projectName = directory.slug;
            if (plugin.lookupExistingDeployment) {
                const lookup = await plugin.lookupExistingDeployment(projectName, token, teamScope);
                await this.directoryRepository.update(directory.id, {
                    website: lookup.website ?? undefined,
                });
            }
        }

        return removed;
    }

    /**
     * Verify a domain on a deployed directory
     */
    async verifyDomain(domain: string, options: DeployFacadeOptions): Promise<DeploymentDomain> {
        const { plugin, token, directory } = await this.resolvePluginAndTokenWithDirectory(options);
        if (!plugin.verifyDomain) {
            throw new DeployFacadeError(
                'Domain management is not supported by this provider',
                'verifyDomain',
                plugin.id,
            );
        }
        const projectId = await this.resolveProjectId(plugin, token, directory, options);
        const teamScope = await this.getTeamScope(plugin.id, options);
        const result = await plugin.verifyDomain(projectId, domain, token, teamScope);

        // Update directory.website if newly verified
        if (result.verified) {
            await this.directoryRepository.update(directory.id, {
                website: `https://${result.name}`,
            });
        }

        return result;
    }

    // Private methods

    private async resolvePluginAndToken(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
    }> {
        const { plugin, token } = await this.resolvePluginAndTokenWithDirectory(options);
        return { plugin, token };
    }

    private async resolvePluginAndTokenWithDirectory(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        directory: Directory;
    }> {
        const directory = await this.directoryRepository.findById(options.directoryId);
        if (!directory) {
            throw new DeployFacadeError(
                `Directory not found: ${options.directoryId}`,
                'resolvePlugin',
            );
        }

        const providerId = directory.deployProvider;
        if (!providerId) {
            throw new NoDeployProviderError();
        }

        const registered = this.registry.get(providerId);
        if (!registered || !registered.manifest.capabilities.includes(this.CAPABILITY)) {
            throw new DeployProviderNotFoundError(providerId);
        }

        if (registered.state !== 'loaded') {
            throw new DeployProviderNotFoundError(providerId);
        }

        // Get token from plugin settings (user-required mode)
        const token = await this.getTokenFromSettings(
            providerId,
            options.userId,
            options.directoryId,
        );

        if (!token) {
            const providerName =
                (registered.plugin as IDeploymentPlugin).providerName || registered.plugin.name;
            throw new NoDeployCredentialsError(providerId, options.userId, providerName);
        }

        return {
            plugin: registered.plugin as IDeploymentPlugin,
            token,
            directory,
        };
    }

    /**
     * Resolve the Vercel projectId for a directory
     */
    private async resolveProjectId(
        plugin: IDeploymentPlugin,
        token: string,
        directory: Directory,
        options: DeployFacadeOptions,
    ): Promise<string> {
        const teamScope = await this.getTeamScope(plugin.id, options);
        if (plugin.lookupExistingDeployment) {
            const result = await plugin.lookupExistingDeployment(directory.slug, token, teamScope);
            if (result.found && result.projectId) {
                return result.projectId;
            }
        }
        throw new DeployFacadeError(
            'Could not resolve project ID. Ensure a deployment exists.',
            'resolveProjectId',
            plugin.id,
        );
    }

    /**
     * Get team scope from plugin settings
     */
    private async getTeamScope(pluginId: string, options: DeployFacadeOptions): Promise<string | undefined> {
        const settings = await this.settingsService.getSettings(pluginId, {
            userId: options.userId,
            directoryId: options.directoryId,
            includeSecrets: false,
        });
        return settings.defaultTeamScope as string | undefined;
    }

    /**
     * Get deployment token from plugin settings
     * For user-required configuration mode, only user settings are checked.
     */
    private async getTokenFromSettings(
        pluginId: string,
        userId: string,
        directoryId?: string,
    ): Promise<string | null> {
        try {
            const settings = await this.settingsService.getResolvedSettings(pluginId, {
                userId,
                directoryId,
                includeSecrets: true,
            });

            // Look for apiToken (Vercel) or generic token fields
            const token =
                (settings.apiToken?.value as string) ||
                (settings.token?.value as string) ||
                (settings.accessToken?.value as string);

            return token || null;
        } catch {
            return null;
        }
    }
}
