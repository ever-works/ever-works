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
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { GitFacadeService } from './git.facade';
import { WorkCustomDomainRepository } from '../database/repositories/work-custom-domain.repository';
import { FacadeError, NoProviderError, ProviderNotFoundError } from './base.facade';
import type { Work } from '../entities/work.entity';
import type { User } from '../entities/user.entity';

const KUBERNETES_DEPLOY_PROVIDER_ID = 'k8s';
const EVER_WORKS_DEPLOY_PROVIDER_ID = 'ever-works';

function resolvePluginProviderId(providerId: string): string {
    return providerId === EVER_WORKS_DEPLOY_PROVIDER_ID
        ? KUBERNETES_DEPLOY_PROVIDER_ID
        : providerId;
}

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
    /** Override the provider (instead of using work.deployProvider) */
    providerOverride?: string;
}

/**
 * DeployFacadeService provides a unified interface for deployment operations.
 *
 * It resolves the deployment provider from work.deployProvider and retrieves
 * credentials from plugin settings (user-scoped). This facade implements the
 * IDeployFacade interface from the plugin package.
 *
 * Key differences from other facades:
 * - Uses work.deployProvider instead of capability-based resolution
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
        private readonly workRepository: WorkRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly domainRepository: WorkCustomDomainRepository,
        private readonly workPluginRepository?: WorkPluginRepository,
    ) {}

    /**
     * Check if deployment is configured for a work
     */
    async isConfigured(options: DeployFacadeOptions): Promise<boolean> {
        try {
            const work = await this.workRepository.findById(options.workId);
            if (!work?.deployProvider) {
                return false;
            }

            const pluginProviderId = resolvePluginProviderId(work.deployProvider);
            const registered = this.registry.get(pluginProviderId);
            if (!registered || registered.state !== 'loaded') {
                return false;
            }

            // Check if user has configured their token
            const token = await this.getTokenFromSettings(
                pluginProviderId,
                options.userId,
                options.workId,
            );
            return !!token;
        } catch {
            return false;
        }
    }

    /**
     * Check whether a specific deployment provider has user credentials.
     * This is used by provider listing/configuration UI where there may be no
     * work selected yet.
     */
    async isProviderConfigured(
        providerId: string,
        userId: string,
        workId?: string,
    ): Promise<boolean> {
        const registered = this.registry.get(providerId);
        if (!registered || registered.state !== 'loaded') {
            return false;
        }
        if (!registered.manifest.capabilities.includes(this.CAPABILITY)) {
            return false;
        }
        return !!(await this.getTokenFromSettings(providerId, userId, workId));
    }

    /**
     * Get list of available deployment providers
     */
    getAvailableProviders(): DeployProviderInfo[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: p.plugin.name || (p.plugin as IDeploymentPlugin).providerName || p.plugin.id,
            enabled: p.state === 'loaded',
            icon: p.manifest.icon,
            description: p.manifest.description,
            homepage: p.manifest.homepage,
        }));
    }

    /**
     * Get deployment providers with user-scoped credential state.
     *
     * `enabled` means the plugin is loaded. `configured` means this user has
     * supplied the provider's primary credential.
     */
    async getAvailableProvidersForUser(userId: string): Promise<DeployProviderInfo[]> {
        const providers = this.getAvailableProviders();
        return Promise.all(
            providers.map(async (provider) => ({
                ...provider,
                configured: provider.enabled
                    ? await this.isProviderConfigured(provider.id, userId)
                    : false,
            })),
        );
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
        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
        const user = work.user as User;

        // Get git token for repository operations
        const gitToken = await this.gitFacade.getAccessToken({
            userId: user.id,
            providerId: work.gitProvider,
            workId: work.id,
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
     * Lookup existing deployment for a work
     */
    async lookupExistingDeployment(
        projectName: string,
        options: DeployFacadeOptions,
    ): Promise<DeploymentLookupResult> {
        try {
            const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);

            // Get team scope from settings
            const settings = await this.settingsService.getSettings(plugin.id, {
                userId: options.userId,
                workId: options.workId,
                includeSecrets: false,
            });
            const teamScope = settings.defaultTeamScope as string | undefined;

            if (plugin.lookupExistingDeployment) {
                const result = await plugin.lookupExistingDeployment(projectName, token, teamScope);

                // Update work with deployment info if found
                if (result.found && (result.website || result.deploymentState)) {
                    await this.workRepository.update(work.id, {
                        website: result.website ?? undefined,
                        deploymentState: result.deploymentState ?? work.deploymentState,
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
     * Get deployment token for a user/work
     * (Used by the deploy service for setting repository secrets)
     */
    async getDeployToken(options: DeployFacadeOptions): Promise<string | null> {
        try {
            const work = await this.workRepository.findById(options.workId);
            if (!work?.deployProvider) {
                return null;
            }
            return this.getTokenFromSettings(
                resolvePluginProviderId(work.deployProvider),
                options.userId,
                options.workId,
            );
        } catch {
            return null;
        }
    }

    /**
     * Get the deployment provider for a work
     */
    async getWorkProvider(workId: string): Promise<string | null> {
        const work = await this.workRepository.findById(workId);
        return work?.deployProvider ?? null;
    }

    /**
     * Set deployment provider for a work
     */
    async setWorkProvider(workId: string, providerId: string): Promise<void> {
        await this.workRepository.update(workId, {
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
        work: Work;
    }> {
        return this.resolvePluginAndTokenWithWork(options);
    }

    /**
     * Get the resolved plugin, token, work AND raw settings for deployment.
     * Settings include secrets — only the deploy service / orchestrators
     * should call this so it can push plugin-specific secrets via
     * `IDeploymentPlugin.getDeploymentSecrets(settings)`.
     */
    async getPluginAndTokenAndSettings(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        work: Work;
        settings: Record<string, unknown>;
    }> {
        const result = await this.resolvePluginAndTokenWithWork(options);
        const settings = await this.settingsService.getSettings(result.plugin.id, {
            userId: options.userId,
            workId: options.workId,
            includeSecrets: true,
        });
        return { ...result, settings };
    }

    /**
     * Resolve another plugin's user-scoped settings for the same deploy
     * request. The k8s deploy needs to read the GitHub plugin's
     * `readPackagesPat` to mint an imagePullSecret for private GHCR — but
     * the k8s plugin itself has no cross-plugin access. The deploy
     * orchestrator is the right layer to do this stitching, so this method
     * exposes the (already-injected) settings service in a controlled,
     * secret-including form.
     */
    async getOtherPluginSettings(
        pluginId: string,
        options: DeployFacadeOptions,
    ): Promise<Record<string, unknown>> {
        return this.settingsService.getSettings(pluginId, {
            userId: options.userId,
            workId: options.workId,
            includeSecrets: true,
        });
    }

    // Domain management methods
    // DB is the primary source of truth; provider APIs are used for sync and verification.

    /**
     * Get domains for a deployed work.
     * Reads from DB, enriches with provider verification data when available.
     */
    async getDomains(options: DeployFacadeOptions): Promise<DeploymentDomain[]> {
        const dbDomains = await this.domainRepository.findByWork(options.workId);
        const hasCustomDomain = dbDomains.some(
            (domain) => !this.isAutoAssignedDomain(domain.domain),
        );
        const shouldAutoImportProviderDomains = !hasCustomDomain;

        // Try to enrich with provider verification data
        let providerDomains: DeploymentDomain[] = [];
        let providerId: string | undefined;

        try {
            const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
            providerId = plugin.id;
            if (plugin.getDomains) {
                const projectId = await this.resolveProjectId(plugin, token, work, options);
                const teamScope = await this.getTeamScope(plugin.id, options);
                providerDomains = await plugin.getDomains(projectId, token, teamScope);
                if (shouldAutoImportProviderDomains) {
                    await this.reconcileProviderDomains(options.workId, plugin.id, providerDomains);
                }
            }
        } catch (error) {
            this.logger.warn(`Failed to fetch provider domains for enrichment: ${error}`);
        }

        // Build a lookup map from provider data
        const providerMap = new Map<string, DeploymentDomain>();
        for (const pd of providerDomains) {
            providerMap.set(pd.name, pd);
        }

        const merged = dbDomains.map((dbDomain) => {
            const providerData = providerMap.get(dbDomain.domain);
            return {
                name: dbDomain.domain,
                verified: providerData?.verified ?? dbDomain.verified,
                verification: providerData?.verification,
            };
        });

        if (shouldAutoImportProviderDomains) {
            const dbDomainNames = new Set(dbDomains.map((domain) => domain.domain));
            for (const providerDomain of providerDomains) {
                if (dbDomainNames.has(providerDomain.name)) continue;

                merged.push({
                    name: providerDomain.name,
                    verified: providerDomain.verified,
                    verification: providerDomain.verification,
                });
            }
        }

        if (providerId && providerDomains.length > 0) {
            this.logger.debug(
                `Resolved ${providerDomains.length} domain(s) from provider ${providerId} for work ${options.workId}`,
            );
        }

        return this.sortDomainsForDisplay(merged);
    }

    private async reconcileProviderDomains(
        workId: string,
        providerId: string,
        providerDomains: DeploymentDomain[],
    ): Promise<void> {
        for (const providerDomain of providerDomains) {
            try {
                const existing = await this.domainRepository.findOne(workId, providerDomain.name);
                if (!existing) {
                    await this.domainRepository.addDomain(workId, providerDomain.name, providerId);
                } else if (existing.provider !== providerId) {
                    await this.domainRepository.updateProvider(
                        workId,
                        providerDomain.name,
                        providerId,
                    );
                }

                await this.domainRepository.updateVerified(
                    workId,
                    providerDomain.name,
                    providerDomain.verified,
                );
            } catch (error) {
                this.logger.warn(
                    `Failed to reconcile provider domain "${providerDomain.name}" for work ${workId}: ${error}`,
                );
            }
        }
    }

    /**
     * Add a domain to a deployed work.
     * Provider state is checked first so domains already attached outside Ever Works are imported.
     */
    async addDomain(domain: string, options: DeployFacadeOptions): Promise<AddDomainResult> {
        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
        if (!plugin.addDomain) {
            throw new DeployFacadeError(
                'Domain management is not supported by this provider',
                'addDomain',
                plugin.id,
            );
        }

        const projectId = await this.resolveProjectId(plugin, token, work, options);
        const teamScope = await this.getTeamScope(plugin.id, options);
        const existing = await this.domainRepository.findOne(options.workId, domain);

        if (plugin.getDomains) {
            const providerDomain = await this.findProviderDomain(
                plugin,
                projectId,
                token,
                teamScope,
                domain,
            );

            if (providerDomain) {
                await this.reconcileProviderDomains(options.workId, plugin.id, [providerDomain]);
                await this.promoteVerifiedDomainWebsite(work, providerDomain);
                return {
                    domain: providerDomain,
                    verified: providerDomain.verified,
                };
            }
        }

        if (existing) {
            return {
                domain: {
                    name: existing.domain,
                    verified: existing.verified,
                },
                verified: existing.verified,
            };
        }

        // Push to provider
        let result: AddDomainResult;
        try {
            result = await plugin.addDomain(projectId, domain, token, teamScope);
        } catch (error) {
            throw error;
        }

        await this.domainRepository.addDomain(options.workId, domain, plugin.id);
        if (result.verified) {
            await this.domainRepository.updateVerified(options.workId, domain, true);
            await this.promoteVerifiedDomainWebsite(work, result.domain);
        }

        return result;
    }

    private async findProviderDomain(
        plugin: IDeploymentPlugin,
        projectId: string,
        token: string,
        teamScope: string | undefined,
        domain: string,
    ): Promise<DeploymentDomain | undefined> {
        if (!plugin.getDomains) return undefined;

        try {
            const providerDomains = await plugin.getDomains(projectId, token, teamScope);
            return providerDomains.find((item) => item.name === domain);
        } catch (error) {
            this.logger.warn(
                `Failed to check provider domains before adding "${domain}": ${error}`,
            );
            return undefined;
        }
    }

    private async promoteVerifiedDomainWebsite(
        work: Work,
        domain: DeploymentDomain,
    ): Promise<void> {
        if (!domain.verified) return;

        // Only promote to primary URL if current website is auto-assigned or unset
        const isAutoAssigned = !work.website || work.website.endsWith('.vercel.app');
        if (!isAutoAssigned) return;

        await this.workRepository.update(work.id, {
            website: `https://${domain.name}`,
        });
    }

    private isAutoAssignedDomain(domain: string): boolean {
        return domain.endsWith('.vercel.app');
    }

    private sortDomainsForDisplay(domains: DeploymentDomain[]): DeploymentDomain[] {
        return [...domains].sort((left, right) => {
            const leftAutoAssigned = this.isAutoAssignedDomain(left.name);
            const rightAutoAssigned = this.isAutoAssignedDomain(right.name);

            if (leftAutoAssigned === rightAutoAssigned) {
                return left.name.localeCompare(right.name);
            }

            return leftAutoAssigned ? 1 : -1;
        });
    }

    /**
     * Remove a domain from a deployed work.
     * Removes from provider first, then from DB.
     */
    async removeDomain(domain: string, options: DeployFacadeOptions): Promise<boolean> {
        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);

        // If provider supports removal and domain is synced, remove from provider
        const dbRecord = await this.domainRepository.findOne(options.workId, domain);
        if (dbRecord?.provider && plugin.removeDomain) {
            try {
                const projectId = await this.resolveProjectId(plugin, token, work, options);
                const teamScope = await this.getTeamScope(plugin.id, options);
                await plugin.removeDomain(projectId, domain, token, teamScope);
            } catch (error) {
                this.logger.warn(
                    `Failed to remove domain from provider, removing from DB anyway: ${error}`,
                );
            }
        }

        // Remove from DB
        const removed = await this.domainRepository.removeDomain(options.workId, domain);

        // If the removed domain was the current website URL, re-lookup to update
        if (removed && work.website === `https://${domain}`) {
            try {
                const teamScope = await this.getTeamScope(plugin.id, options);
                if (plugin.lookupExistingDeployment) {
                    const lookup = await plugin.lookupExistingDeployment(
                        work.slug,
                        token,
                        teamScope,
                    );
                    await this.workRepository.update(work.id, {
                        website: lookup.website ?? undefined,
                    });
                }
            } catch (error) {
                this.logger.warn(`Failed to re-lookup website URL after domain removal: ${error}`);
            }
        }

        return removed;
    }

    /**
     * Verify a domain on a deployed work.
     * Verifies at provider, updates DB with result.
     */
    async verifyDomain(domain: string, options: DeployFacadeOptions): Promise<DeploymentDomain> {
        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
        if (!plugin.verifyDomain) {
            throw new DeployFacadeError(
                'Domain management is not supported by this provider',
                'verifyDomain',
                plugin.id,
            );
        }
        const projectId = await this.resolveProjectId(plugin, token, work, options);
        const teamScope = await this.getTeamScope(plugin.id, options);
        const result = await plugin.verifyDomain(projectId, domain, token, teamScope);

        // Update DB with verification result
        await this.domainRepository.updateVerified(options.workId, domain, result.verified);

        // Only promote to primary URL if current website is auto-assigned or unset
        if (result.verified) {
            const isAutoAssigned = !work.website || work.website.endsWith('.vercel.app');
            if (isAutoAssigned) {
                await this.workRepository.update(work.id, {
                    website: `https://${result.name}`,
                });
            }
        }

        return result;
    }

    // Private methods

    private async resolvePluginAndToken(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
    }> {
        const { plugin, token } = await this.resolvePluginAndTokenWithWork(options);
        return { plugin, token };
    }

    private async resolvePluginAndTokenWithWork(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        work: Work;
    }> {
        const work = await this.workRepository.findById(options.workId);
        if (!work) {
            throw new DeployFacadeError(`Work not found: ${options.workId}`, 'resolvePlugin');
        }

        const providerId = work.deployProvider;
        if (!providerId) {
            throw new NoDeployProviderError();
        }

        const pluginProviderId = resolvePluginProviderId(providerId);
        const registered = this.registry.get(pluginProviderId);
        if (!registered || !registered.manifest.capabilities.includes(this.CAPABILITY)) {
            throw new DeployProviderNotFoundError(providerId);
        }

        if (registered.state !== 'loaded') {
            throw new DeployProviderNotFoundError(providerId);
        }

        // Get token from plugin settings (user-required mode)
        const token = await this.getTokenFromSettings(
            pluginProviderId,
            options.userId,
            options.workId,
        );

        if (!token) {
            const providerName =
                (registered.plugin as IDeploymentPlugin).providerName || registered.plugin.name;
            throw new NoDeployCredentialsError(providerId, options.userId, providerName);
        }

        return {
            plugin: registered.plugin as IDeploymentPlugin,
            token,
            work,
        };
    }

    /**
     * Resolve the deployment projectId for a work.
     * Uses the cached deployProjectId when available to avoid redundant API calls.
     */
    private async resolveProjectId(
        plugin: IDeploymentPlugin,
        token: string,
        work: Work,
        options: DeployFacadeOptions,
    ): Promise<string> {
        // Use cached value if available
        if (work.deployProjectId) {
            return work.deployProjectId;
        }

        const teamScope = await this.getTeamScope(plugin.id, options);
        if (plugin.lookupExistingDeployment) {
            const result = await plugin.lookupExistingDeployment(
                work.getWebsiteRepo(),
                token,
                teamScope,
            );
            if (result.found && result.projectId) {
                // Cache the projectId for future calls
                await this.workRepository.update(work.id, {
                    deployProjectId: result.projectId,
                });
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
    private async getTeamScope(
        pluginId: string,
        options: DeployFacadeOptions,
    ): Promise<string | undefined> {
        const settings = await this.settingsService.getSettings(pluginId, {
            userId: options.userId,
            workId: options.workId,
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
        workId?: string,
    ): Promise<string | null> {
        try {
            const settings = await this.settingsService.getResolvedSettings(pluginId, {
                userId,
                workId,
                includeSecrets: true,
            });

            // EW-616: for the k8s plugin, when the user picked a
            // platform-managed cluster (`k8s-works` / `k8s-gauzy`) the
            // pasted kubeconfig is intentionally empty —
            // `DeployService.resolveDeployToken()` substitutes the
            // platform's kubeconfig from `EVER_WORKS_K8S_*_KUBECONFIG`
            // env vars at deploy time. Return a non-empty sentinel here
            // so the facade considers the work "configured" and lets the
            // deploy proceed; the sentinel is discarded downstream.
            if (pluginId === 'k8s') {
                const clusterSource = settings.clusterSource?.value as string | undefined;
                if (clusterSource === 'k8s-works' || clusterSource === 'k8s-gauzy') {
                    return (
                        (settings.kubeconfig?.value as string) ||
                        PLATFORM_MANAGED_KUBECONFIG_SENTINEL
                    );
                }
            }

            // Look for provider primary credential fields.
            // Vercel uses apiToken; Kubernetes uses kubeconfig; other
            // providers commonly use token/accessToken.
            const token =
                (settings.apiToken?.value as string) ||
                (settings.kubeconfig?.value as string) ||
                (settings.token?.value as string) ||
                (settings.accessToken?.value as string);

            return token || null;
        } catch {
            return null;
        }
    }
}

/**
 * Sentinel value returned by `getTokenFromSettings` for k8s deploys
 * targeting a platform-managed cluster (`k8s-works` / `k8s-gauzy`).
 * The deploy facade only checks that a token is non-empty before
 * deciding the work is "configured", so any unique string works.
 * `DeployService.resolveDeployToken()` discards this sentinel and
 * substitutes the real platform kubeconfig from
 * `EVER_WORKS_K8S_*_KUBECONFIG` env vars at deploy time.
 *
 * Exported so callers (or tests) can pattern-match on it if needed.
 */
export const PLATFORM_MANAGED_KUBECONFIG_SENTINEL = '__ever-works-platform-managed-kubeconfig__';
