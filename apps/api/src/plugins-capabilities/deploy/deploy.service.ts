import {
    BadRequestException,
    Injectable,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'crypto';
import {
    DeployFacadeService,
    GitFacadeService,
    PLATFORM_MANAGED_KUBECONFIG_SENTINEL,
} from '@ever-works/agent/facades';
import { WorkRepository } from '@ever-works/agent/database';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { Work, User } from '@ever-works/agent/entities';
import { PlatformSyncSecretService } from '@ever-works/agent/services';
import { EverWorksDnsService } from '@ever-works/agent/ever-works-providers';
import {
    WebsiteUpdateService,
    getWebsiteTemplateBranch,
    WebsiteTemplateResolverService,
} from '@ever-works/agent/generators';
import { DeploymentDispatchedEvent } from '@ever-works/agent/events';
import type { IDeploymentPlugin } from '@ever-works/plugin';
import type { BatchDeployItemDto, BatchDeployItemResultDto } from './dto/batch-deploy.dto';
import {
    ClusterSource,
    resolveKubeconfigForClusterSource,
    validateClusterSourceForOwner,
} from './cluster-source-matrix';

const VALID_CLUSTER_SOURCES: readonly ClusterSource[] = [
    'k8s-works',
    'k8s-gauzy',
    'custom-kubeconfig',
];

function coerceClusterSource(value: unknown): ClusterSource {
    if (typeof value === 'string' && (VALID_CLUSTER_SOURCES as readonly string[]).includes(value)) {
        return value as ClusterSource;
    }
    // Back-compat: Works that pre-date the EW-616 dropdown have no
    // `clusterSource` set in their plugin settings. Treat them as
    // `custom-kubeconfig` so they keep working as long as their
    // website repo is not in an Ever Works-shared org.
    return 'custom-kubeconfig';
}

/**
 * Default workflow filenames to dispatch when a deployment plugin does not
 * implement `getWorkflowFilenames()` (e.g. older plugins without the optional
 * contract method). Vercel returns ['deploy_vercel.yaml', 'deploy_prod.yaml']
 * via the new method; this fallback covers everything else.
 */
const DEFAULT_WORKFLOW_FILES: readonly string[] = ['deploy_prod.yaml'];

interface RepoContext {
    owner: string;
    repo: string;
    token: string;
    publicKey: { key_id: string; key: string };
}

/**
 * DeployService handles deployment operations using the plugin system.
 *
 * It coordinates with:
 * - DeployFacade: For provider resolution and token management
 * - GitFacade: For repository operations and secrets
 * - WebsiteUpdateService: For repository updates
 */
@Injectable()
export class DeployService {
    private readonly logger = new Logger(DeployService.name);
    private readonly CRON_SECRET_LENGTH = 32;

    constructor(
        private readonly deployFacade: DeployFacadeService,
        private readonly gitFacade: GitFacadeService,
        private readonly workRepository: WorkRepository,
        private readonly pluginRegistry: PluginRegistryService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly websiteTemplateResolver: WebsiteTemplateResolverService,
        private readonly eventEmitter: EventEmitter2,
        private readonly platformSyncSecretService: PlatformSyncSecretService,
        private readonly dnsService: EverWorksDnsService,
    ) {}

    /**
     * Deploy a work using its configured deployment provider
     */
    async deploy(
        workId: string,
        userId: string,
        options: { teamScope?: string },
    ): Promise<boolean> {
        const { plugin, token, work, settings } =
            await this.deployFacade.getPluginAndTokenAndSettings({
                userId,
                workId,
            });

        const user = work.user as User;
        const gitToken = await this.gitFacade.getAccessToken({
            userId: user.id,
            providerId: work.gitProvider,
            workId: work.id,
        });

        if (!gitToken) {
            throw new Error('Git provider token not available');
        }

        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();

        // EW-616: enforce the deploy matrix for k8s deploys.
        // - `k8s-gauzy` is admin-only (ever-works org).
        // - Ever Works-shared GHCR + customer-provided cluster is rejected
        //   to avoid cross-tenant credential exposure.
        // The resolved kubeconfig replaces the user-pasted one for
        // platform-managed sources.
        const effectiveDeployToken = this.resolveDeployToken(
            work.deployProvider,
            websiteOwner,
            settings ?? {},
            token,
        );

        const ctx = await this.createRepoContext(websiteOwner, websiteRepo, gitToken);

        await this.enableWorkflows({
            owner: ctx.owner,
            repo: ctx.repo,
            token: ctx.token,
            withDelay: false,
        });

        // EW-617 G5: when the platform is the deploy target, template the
        // ingress host as `${slug}.ever.works` (or whatever
        // EVER_WORKS_DOMAIN says) and provision the Cloudflare CNAME so
        // the user's directory is reachable at that subdomain without any
        // manual DNS. If env vars are missing the DNS service no-ops; the
        // k8s plugin's default LB hostname remains the fallback.
        const deploySettings = await this.applyEverWorksSubdomain(work, settings);
        await this.setRequiredSecrets(ctx, effectiveDeployToken, work, plugin, deploySettings);
        await this.setKubernetesGhcrPullSecret(ctx, work, userId);
        await this.setOptionalSecrets(ctx, options.teamScope, gitToken);
        await this.ensureCronSecret(ctx);

        const dispatched = await this.dispatchWithRetry(work, user, gitToken, plugin);

        // Fire-and-forget event so the activity-log listener (and any
        // future subscribers — Sentry breadcrumbs, metrics, etc.) can
        // record the dispatch without DeployService taking a hard
        // dependency on ActivityLogService.
        if (dispatched) {
            this.eventEmitter.emit(
                DeploymentDispatchedEvent.EVENT_NAME,
                new DeploymentDispatchedEvent({
                    work,
                    userId,
                    providerId: plugin.id,
                    providerName: plugin.providerName ?? plugin.name ?? plugin.id,
                }),
            );
        }

        return dispatched;
    }

    /**
     * Batch deploy multiple works
     */
    async deployBatch(
        works: BatchDeployItemDto[],
        userId: string,
        defaultTeamScope?: string,
    ): Promise<{
        totalRequested: number;
        successfullyStarted: number;
        failed: number;
        results: BatchDeployItemResultDto[];
    }> {
        const results: BatchDeployItemResultDto[] = [];
        let successCount = 0;
        let failCount = 0;

        const MAX_CONCURRENT = 5;

        for (let i = 0; i < works.length; i += MAX_CONCURRENT) {
            const batch = works.slice(i, i + MAX_CONCURRENT);

            const batchResults = await Promise.allSettled(
                batch.map((item) =>
                    this.deploySingle(item.workId, userId, item.teamScope || defaultTeamScope),
                ),
            );

            for (let j = 0; j < batchResults.length; j++) {
                const result = batchResults[j];
                const item = batch[j];

                if (result.status === 'fulfilled') {
                    results.push(result.value);
                    if (result.value.status === 'pending') {
                        successCount++;
                    } else {
                        failCount++;
                    }
                } else {
                    failCount++;
                    results.push({
                        workId: item.workId,
                        slug: 'unknown',
                        status: 'error',
                        message: result.reason?.message || 'Unknown error',
                    });
                }
            }

            if (i + MAX_CONCURRENT < works.length) {
                await new Promise((r) => setTimeout(r, 2000));
            }
        }

        return {
            totalRequested: works.length,
            successfullyStarted: successCount,
            failed: failCount,
            results,
        };
    }

    private async deploySingle(
        workId: string,
        userId: string,
        teamScope?: string,
    ): Promise<BatchDeployItemResultDto> {
        try {
            const work = await this.workRepository.findById(workId);
            if (!work) {
                return {
                    workId,
                    slug: 'unknown',
                    status: 'error',
                    message: 'Work not found',
                };
            }

            const success = await this.deploy(workId, userId, { teamScope });

            return {
                workId,
                slug: work.slug,
                status: success ? 'pending' : 'error',
                message: success ? 'Deployment started' : 'Failed to initiate deployment',
                owner: work.getRepoOwner('website'),
                repository: `${work.getRepoOwner('website')}/${work.getWebsiteRepo()}`,
            };
        } catch (error) {
            return {
                workId,
                slug: 'unknown',
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * EW-616: Apply the deploy-matrix validation for the k8s provider and
     * substitute the platform's kubeconfig env var when the user picked a
     * platform-managed cluster source. For non-k8s providers (Vercel, etc.)
     * this is a pass-through and the validation is skipped.
     */
    private resolveDeployToken(
        deployProvider: string | undefined,
        websiteOwner: string,
        settings: Record<string, unknown>,
        userToken: string,
    ): string {
        if (deployProvider !== 'k8s') {
            return userToken;
        }

        // EW-616: the deploy facade returns a sentinel string when the
        // user picked a platform-managed cluster without pasting a
        // kubeconfig. Treat it as "no kubeconfig" for the validator and
        // discard it before resolution so it can never leak into the
        // pushed `K8S_TOKEN` secret on the website repo.
        const realUserToken = userToken === PLATFORM_MANAGED_KUBECONFIG_SENTINEL ? '' : userToken;

        const clusterSource = coerceClusterSource(settings.clusterSource);
        const failure = validateClusterSourceForOwner(websiteOwner, clusterSource, {
            hasKubeconfig: Boolean(realUserToken && realUserToken.trim()),
        });
        if (failure) {
            this.logger.warn(
                `EW-616 deploy-matrix violation [${failure.code}]: ${failure.message}`,
            );
            throw new BadRequestException(failure.message);
        }

        try {
            return resolveKubeconfigForClusterSource(clusterSource, realUserToken);
        } catch (error) {
            // The only failure path here is a missing platform-managed
            // env var (`EVER_WORKS_K8S_WORKS_KUBECONFIG` /
            // `EVER_WORKS_K8S_GAUZY_KUBECONFIG`). The user picked a
            // valid option — this is a platform-provisioning gap, so
            // surface it as 5xx, not 4xx, so on-call can distinguish it
            // from genuine user-input errors.
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Cluster-source resolution failed for ${websiteOwner}: ${message}`);
            throw new InternalServerErrorException(message);
        }
    }

    private async createRepoContext(
        owner: string,
        repo: string,
        token: string,
    ): Promise<RepoContext> {
        const publicKey = await this.getRepositoryPublicKey(owner, repo, token);
        return { owner, repo, token, publicKey };
    }

    private async setSecret(ctx: RepoContext, key: string, value: string) {
        return this.setActionSecret(
            { key, value, owner: ctx.owner, repo: ctx.repo },
            ctx.publicKey,
            ctx.token,
        );
    }

    private async setVariable(ctx: RepoContext, key: string, value: string) {
        return this.setActionVariable({ key, value, owner: ctx.owner, repo: ctx.repo }, ctx.token);
    }

    /**
     * EW-617 G5: when `deployProvider === 'ever-works'` AND the Cloudflare
     * DNS env is configured, derive `ingressHost = ${slug}.ever.works`,
     * merge it into the deploy settings (so the k8s plugin's
     * `getDeploymentSecrets` picks it up as `K8S_INGRESS_HOST`), and
     * provision the CNAME via Cloudflare. Returns a shallow copy of
     * `settings` with the override applied; original object is not
     * mutated so subsequent reads stay deterministic.
     *
     * No-ops cleanly when:
     *  - the work is on a non-platform provider (Vercel, user's k8s), OR
     *  - env vars are missing (dev / preview),
     * letting the existing k8s plugin LB hostname remain the fallback.
     */
    private async applyEverWorksSubdomain(
        work: Work,
        settings: Record<string, unknown> | undefined,
    ): Promise<Record<string, unknown> | undefined> {
        if (work.deployProvider !== 'ever-works') {
            return settings;
        }
        const provider = this.dnsService.getProvider();
        if (!provider) {
            return settings;
        }

        const ingressHost = this.dnsService.ingressHostFor(work.slug);

        // Provision asynchronously — DNS propagation runs in parallel with
        // the workflow dispatch. Errors are logged inside the service so
        // they never abort the deploy.
        void this.dnsService.ensureWorkSubdomain(work.slug);

        return {
            ...(settings ?? {}),
            ingressHost,
        };
    }

    private async setRequiredSecrets(
        ctx: RepoContext,
        deployToken: string,
        work: Work,
        plugin?: IDeploymentPlugin,
        settings?: Record<string, unknown>,
    ) {
        const provider = work.deployProvider || 'ever-works';
        try {
            await this.setVariable(ctx, 'DEPLOY_PROVIDER', provider);
        } catch (error) {
            this.logger.error(
                `Failed to set DEPLOY_PROVIDER variable for ${ctx.owner}/${ctx.repo}: ${error.message}`,
            );
        }

        await Promise.all([
            this.setSecret(ctx, 'TENANT_ID', work.id),
            this.setSecret(ctx, 'WORK_ID', work.id),
            this.setSecret(ctx, 'DATA_REPOSITORY', work.getDataRepo()),
            this.setSecret(ctx, `${provider.toUpperCase()}_TOKEN`, deployToken),
            this.setSecret(ctx, 'DEPLOY_TOKEN', deployToken),
        ]);

        // EW-120 dual-mode Activity Feed sync — push the secrets for the
        // active transport only. Disabled mode pushes nothing.
        //
        //   push:    PLATFORM_API_URL + PLATFORM_API_SECRET_TOKEN so the
        //            deployed site can POST events to /api/activity-log/ingest.
        //   pull:    PLATFORM_SYNC_SECRET (per-Work HMAC, lazily provisioned
        //            via `PlatformSyncSecretService.getOrGenerate`) so the
        //            deployed site can verify incoming GET requests from
        //            the platform's DirectoryWebsiteClient.
        //   disabled: skipped entirely — neither transport runs.
        //
        // All branches are best-effort: a failure here logs an error and
        // continues. The Activity Feed degrades to platform-only sources
        // until the next successful deploy.
        const syncMode = work.activitySyncMode ?? 'pull';
        if (syncMode === 'push') {
            const platformApiUrl = process.env.PLATFORM_API_URL;
            const platformApiSecret = process.env.PLATFORM_API_SECRET_TOKEN;
            if (platformApiUrl && platformApiSecret) {
                try {
                    await Promise.all([
                        this.setSecret(ctx, 'PLATFORM_API_URL', platformApiUrl),
                        this.setSecret(ctx, 'PLATFORM_API_SECRET_TOKEN', platformApiSecret),
                    ]);
                } catch (error) {
                    this.logger.error(
                        `Failed to push PLATFORM_API_* secrets for work ${work.id} on ${ctx.owner}/${ctx.repo}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            } else {
                this.logger.debug(
                    `PLATFORM_API_URL / PLATFORM_API_SECRET_TOKEN not configured on platform; skipping push-mode ingest secret push for work ${work.id}`,
                );
            }
        } else if (syncMode === 'pull') {
            try {
                const platformSyncSecret = await this.platformSyncSecretService.getOrGenerate(
                    work.id,
                );
                await this.setSecret(ctx, 'PLATFORM_SYNC_SECRET', platformSyncSecret);
            } catch (error) {
                this.logger.error(
                    `Failed to push PLATFORM_SYNC_SECRET for work ${work.id} on ${ctx.owner}/${ctx.repo}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        // Plugin-specific extra secrets (k8s registry creds, namespace, etc.)
        // The plugin returns a Record<string, string> of secret name → value;
        // the deploy service pushes each one as a GitHub Actions secret.
        // Older plugins without `getDeploymentSecrets` simply contribute
        // nothing here.
        if (plugin?.getDeploymentSecrets && settings) {
            try {
                const extras = await plugin.getDeploymentSecrets(settings);
                const entries = Object.entries(extras);
                if (entries.length > 0) {
                    await Promise.all(
                        entries.map(([key, value]) => this.setSecret(ctx, key, value)),
                    );
                    this.logger.log(
                        `Pushed ${entries.length} plugin-specific secrets for ${plugin.id} to ${ctx.owner}/${ctx.repo}`,
                    );
                }
            } catch (error) {
                this.logger.error(
                    `Failed to push plugin-specific secrets for ${plugin.id} on ${ctx.owner}/${ctx.repo}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
    }

    /**
     * For k8s deploys, push GHCR image-pull credentials to the website
     * repo as GitHub Actions secrets, so the `deploy_k8s.yaml` workflow
     * can mint a Kubernetes `<work-slug>-pull` imagePullSecret that
     * kubelet uses to fetch the private container image.
     *
     * Three secrets are written (when a credential is available):
     *
     *   - `REGISTRY_PASSWORD` — classic GitHub PAT (`ghp_…`). The
     *     workflow's docker-registry secret step uses this first.
     *     Classic PATs honor org membership directly and bypass the
     *     fragile package↔repo auto-link required by fine-grained
     *     PATs. See `Workspace/knowledge/runbooks/EVER_WORKS_K8S_DEPLOY_TROUBLESHOOTING.md`
     *     gotcha #1 for the full why.
     *   - `REGISTRY_USERNAME` — the PAT owner's GitHub login. Without
     *     this, the workflow defaults to `github.actor` which may be
     *     the platform's deploy bot rather than the PAT owner.
     *   - `GITHUB_READ_PACKAGES_TOKEN` — fine-grained PAT, legacy slot
     *     kept for back-compat. Workflow uses it as a fallback when
     *     `REGISTRY_PASSWORD` is unset.
     *
     * Source priority per PAT:
     *
     *   1. The user's GitHub plugin settings (`readPackagesPatClassic`
     *      for the classic PAT, `readPackagesPat` for the fine-grained
     *      one). Required for Works that push to a customer-owned
     *      GitHub org — cells B/D of the EW-615 deploy matrix.
     *   2. Platform-side env vars when the website repo owner matches
     *      an Ever Works org — `EVER_WORKS_GITHUB_PAT_CLASSIC` /
     *      `EVER_WORKS_GITHUB_PAT` for `ever-works` org,
     *      `EVER_WORKS_CUSTOMERS_GITHUB_PAT_CLASSIC` /
     *      `EVER_WORKS_CUSTOMERS_GITHUB_PAT` for `ever-works-cloud`.
     *      Covers cells A/C — the customer doesn't supply any PAT.
     *   3. If neither source has a value, that secret is skipped. The
     *      workflow has its own fallback chain
     *      (REGISTRY_PASSWORD → GITHUB_READ_PACKAGES_TOKEN → DEPLOY_TOKEN
     *      → GITHUB_TOKEN), so a fully-skipped path still attempts pull
     *      with the workflow's auto-issued GITHUB_TOKEN — which works
     *      only when the package lives in the same repo as the workflow.
     *
     * For non-k8s providers this is a no-op. Errors are logged but
     * never thrown — a failed secret push degrades to "image pull may
     * 403" rather than blocking the whole deploy.
     */
    private async setKubernetesGhcrPullSecret(ctx: RepoContext, work: Work, userId: string) {
        if (work.deployProvider !== 'k8s') {
            return;
        }
        try {
            const githubSettings = await this.deployFacade.getOtherPluginSettings('github', {
                userId,
                workId: work.id,
            });
            const userClassic =
                typeof githubSettings?.readPackagesPatClassic === 'string'
                    ? githubSettings.readPackagesPatClassic.trim()
                    : '';
            const userFineGrained =
                typeof githubSettings?.readPackagesPat === 'string'
                    ? githubSettings.readPackagesPat.trim()
                    : '';

            // Platform-side fallback by website repo owner.
            const platformDefaults = this.getPlatformGhcrCredentials(ctx.owner);

            const classicPat = userClassic || platformDefaults.classic;
            const fineGrainedPat = userFineGrained || platformDefaults.fineGrained;
            const registryUsername =
                userClassic || userFineGrained
                    ? platformDefaults.username // fall back to platform login if user didn't tell us their own
                    : platformDefaults.username;

            const writes: Promise<unknown>[] = [];
            const written: string[] = [];

            if (classicPat) {
                writes.push(this.setSecret(ctx, 'REGISTRY_PASSWORD', classicPat));
                written.push('REGISTRY_PASSWORD');
                if (registryUsername) {
                    writes.push(this.setSecret(ctx, 'REGISTRY_USERNAME', registryUsername));
                    written.push('REGISTRY_USERNAME');
                }
            }

            if (fineGrainedPat) {
                writes.push(this.setSecret(ctx, 'GITHUB_READ_PACKAGES_TOKEN', fineGrainedPat));
                written.push('GITHUB_READ_PACKAGES_TOKEN');
            }

            if (writes.length === 0) {
                // Workflow falls back to GITHUB_TOKEN; that works when the
                // image and the workflow are in the same repo (the default
                // case for the generated website's own GHCR image).
                return;
            }

            await Promise.all(writes);
            this.logger.log(
                `Pushed GHCR pull credentials to ${ctx.owner}/${ctx.repo} for k8s deploy: ${written.join(', ')}`,
            );
        } catch (error) {
            // Don't block the deploy on this — the workflow has a safe
            // fallback. Just log so operators can debug if pulls fail.
            this.logger.warn(
                `Failed to push GHCR pull credentials for ${ctx.owner}/${ctx.repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Look up platform-side GHCR credentials for a website-repo owner.
     * These are used as a fallback when the customer hasn't entered
     * their own PATs in the GitHub plugin settings — the typical case
     * for Works that publish to an Ever Works-shared GitHub org
     * (cells A and C of the EW-615 deploy matrix).
     *
     * The platform reads these from env vars at boot (sourced from
     * the DO k8s Secret `ever-works-secrets` in prod, or
     * `Workspace/.config/ever-works.env` in local dev). Missing env
     * vars are treated as "no platform default available", and the
     * caller degrades accordingly.
     *
     * Adding a new Ever Works-shared org: extend the switch below
     * with a new case and provision the matching env vars. Document
     * in `Workspace/.config/ever-works.env`.
     */
    private getPlatformGhcrCredentials(websiteRepoOwner: string): {
        classic: string;
        fineGrained: string;
        username: string;
    } {
        const empty = { classic: '', fineGrained: '', username: '' };
        const username = (process.env.EVER_WORKS_GITHUB_PAT_OWNER || '').trim();
        switch (websiteRepoOwner.toLowerCase()) {
            case 'ever-works':
                return {
                    classic: (process.env.EVER_WORKS_GITHUB_PAT_CLASSIC || '').trim(),
                    fineGrained: (process.env.EVER_WORKS_GITHUB_PAT || '').trim(),
                    username,
                };
            case 'ever-works-cloud':
                return {
                    classic: (process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT_CLASSIC || '').trim(),
                    fineGrained: (process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT || '').trim(),
                    username,
                };
            default:
                return empty;
        }
    }

    private async setOptionalSecrets(ctx: RepoContext, teamScope?: string, gitToken?: string) {
        const promises: Promise<void>[] = [];

        if (teamScope) {
            promises.push(this.setSecret(ctx, 'DEPLOY_TEAM_SCOPE', teamScope));
        }

        if (gitToken) {
            promises.push(this.setSecret(ctx, 'GH_TOKEN', gitToken));
        }

        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    private async ensureCronSecret(ctx: RepoContext) {
        // Always set a cron secret for new deployments
        const cronSecret = this.generateSecureToken();
        await this.setSecret(ctx, 'CRON_SECRET', cronSecret);
    }

    private generateSecureToken(): string {
        return randomBytes(this.CRON_SECRET_LENGTH).toString('hex');
    }

    private async dispatchWithRetry(
        work: Work,
        user: User,
        gitToken: string,
        plugin?: IDeploymentPlugin,
    ): Promise<boolean> {
        // Resolve workflow files from the plugin (capability-driven). Plugins
        // without `getWorkflowFilenames` use the default fallback list. This
        // replaces the hardcoded `['deploy_vercel.yaml', 'deploy_prod.yaml']`
        // that pre-dated the optional contract method.
        const workflowFilesToTry = plugin?.getWorkflowFilenames
            ? plugin.getWorkflowFilenames()
            : [...DEFAULT_WORKFLOW_FILES];
        const owner = work.getRepoOwner('website');
        const repo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolveForWork(work);

        const tryDispatch = async (): Promise<boolean> => {
            for (const workflowFile of workflowFilesToTry) {
                try {
                    this.logger.log(
                        `Attempting to dispatch workflow "${workflowFile}" for ${owner}/${repo}`,
                    );

                    await this.dispatchWorkflow(
                        {
                            workflow: workflowFile,
                            inputs: { environment: 'production' },
                            branch: template.branch,
                            owner,
                            repo,
                        },
                        gitToken,
                    );

                    this.logger.log(
                        `Successfully dispatched workflow "${workflowFile}" for ${owner}/${repo}`,
                    );
                    return true;
                } catch (error) {
                    this.logger.warn(
                        `Failed to dispatch workflow "${workflowFile}" for ${owner}/${repo}: ${error.message}`,
                    );
                }
            }
            return false;
        };

        // First attempt
        const firstAttemptSuccess = await tryDispatch();
        if (firstAttemptSuccess) {
            return true;
        }

        // If dispatch fails, update the repository
        try {
            this.logger.log(`Workflow dispatch failed. Updating repository for ${owner}/${repo}`);
            await this.websiteUpdateService.updateRepository(work, user);
            await this.createTriggerCommit(work, user);
            await this.delay(3000);

            const retrySuccess = await tryDispatch();
            if (retrySuccess) {
                return true;
            }

            this.logger.warn(`Workflow dispatch still failed after updating ${owner}/${repo}`);
            return false;
        } catch (error) {
            this.logger.error(`Failed to update repository for ${owner}/${repo}: ${error.message}`);
            return false;
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async createTriggerCommit(work: Work, user: User): Promise<void> {
        const workOwner = work.user as User;
        const websiteOwner = work.getRepoOwner('website');
        const websiteRepo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolveForWork(work);

        try {
            const repoDir = await this.gitFacade.cloneOrPull(
                {
                    owner: websiteOwner,
                    repo: websiteRepo,
                    branch: getWebsiteTemplateBranch(template, work.websiteTemplateUseBeta),
                    committer: work.resolveCommitter(user),
                },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            const triggerFile = `${repoDir}/.deployment-trigger`;
            const fs = await import('node:fs/promises');
            await fs.writeFile(
                triggerFile,
                `Deployment triggered at ${new Date().toISOString()}\n`,
            );

            await this.gitFacade.add(work.gitProvider, repoDir, '.deployment-trigger');
            await this.gitFacade.commit(
                work.gitProvider,
                repoDir,
                `chore: trigger deployment\n\nTriggered by Ever Works platform`,
                work.resolveCommitter(user),
            );
            await this.gitFacade.push(
                { dir: repoDir },
                {
                    userId: workOwner.id,
                    providerId: work.gitProvider,
                    workId: work.id,
                },
            );

            this.logger.log(`Created trigger commit for ${websiteOwner}/${websiteRepo}`);
        } catch (error) {
            this.logger.warn(
                `Failed to create trigger commit for ${websiteOwner}/${websiteRepo}: ${error.message}`,
            );
        }
    }

    // GitHub Actions operations via plugin

    private getGitHubPlugin(): any {
        const registered = this.pluginRegistry.get('github');
        if (!registered || registered.state !== 'loaded') {
            throw new Error('GitHub plugin not available for CI/CD operations');
        }
        return registered.plugin;
    }

    private async getRepositoryPublicKey(
        owner: string,
        repo: string,
        token: string,
    ): Promise<{ key_id: string; key: string }> {
        const plugin = this.getGitHubPlugin();
        return plugin.getRepositoryPublicKey(owner, repo, token);
    }

    private async setActionSecret(
        data: { key: string; value: string; owner: string; repo: string },
        publicKey: { key_id: string; key: string },
        token: string,
    ): Promise<void> {
        const plugin = this.getGitHubPlugin();
        return plugin.setActionSecret(data, publicKey, token);
    }

    private async setActionVariable(
        data: { key: string; value: string; owner: string; repo: string },
        token: string,
    ): Promise<void> {
        const plugin = this.getGitHubPlugin();
        return plugin.setActionVariable(data, token);
    }

    private async enableWorkflows(params: {
        owner: string;
        repo: string;
        token: string;
        withDelay?: boolean;
    }): Promise<void> {
        const plugin = this.getGitHubPlugin();
        return plugin.enableDeploymentWorkflows(
            params.owner,
            params.repo,
            params.token,
            params.withDelay,
        );
    }

    private async dispatchWorkflow(
        data: {
            workflow: string;
            inputs?: Record<string, unknown>;
            branch: string;
            owner: string;
            repo: string;
        },
        token: string,
    ): Promise<void> {
        const plugin = this.getGitHubPlugin();
        return plugin.dispatchWorkflow(data, token);
    }
}
