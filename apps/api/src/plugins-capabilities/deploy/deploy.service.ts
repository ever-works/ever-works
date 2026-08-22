import {
    BadRequestException,
    Injectable,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'crypto';
import { DeployFacadeService, GitFacadeService } from '@ever-works/agent/facades';
import {
    DeploymentContextResolutionError,
    coerceDeploymentClusterSource,
    resolveEffectiveDeploymentContext,
    type EffectiveDeploymentContext,
} from '@ever-works/agent/deployment-context';
import {
    WorkRepository,
    WorkDeploymentRepository,
    WorkCustomDomainRepository,
} from '@ever-works/agent/database';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import {
    Work,
    User,
    DeploymentEnvironment,
    DeploymentTriggerSource,
} from '@ever-works/agent/entities';
import {
    PlatformSyncSecretService,
    WebhookSecretService,
    WorkRuntimeEnvService,
    ZeroFrictionFunnelService,
} from '@ever-works/agent/services';
import {
    EverWorksDnsService,
    SubdomainAllocator,
    EverWorksDbProvisionService,
} from '@ever-works/agent/ever-works-providers';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';
import {
    WebsiteUpdateService,
    getWebsiteTemplateBranch,
    WebsiteTemplateResolverService,
} from '@ever-works/agent/generators';
import { DeploymentDispatchedEvent } from '@ever-works/agent/events';
import type {
    DeploymentConfig,
    DeploymentResult,
    IDeploymentPlugin,
    SettingSource,
} from '@ever-works/plugin';
import type { BatchDeployItemDto, BatchDeployItemResultDto } from './dto/batch-deploy.dto';

const KUBERNETES_DEPLOY_PROVIDER_ID = 'k8s';
const EVER_WORKS_DEPLOY_PROVIDER_ID = 'ever-works';

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

export interface DeployOptions {
    teamScope?: string;
    correlationId?: string;
    environment?: DeploymentEnvironment;
    branch?: string;
    prNumber?: number;
    commitSha?: string;
    codeUpdateId?: string;
    triggerSource?: DeploymentTriggerSource;
}

export interface DeployResult {
    dispatched: boolean;
    deploymentId: string;
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
        private readonly deploymentRepository: WorkDeploymentRepository,
        private readonly pluginRegistry: PluginRegistryService,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly websiteTemplateResolver: WebsiteTemplateResolverService,
        private readonly eventEmitter: EventEmitter2,
        private readonly platformSyncSecretService: PlatformSyncSecretService,
        private readonly webhookSecretService: WebhookSecretService,
        private readonly workRuntimeEnvService: WorkRuntimeEnvService,
        private readonly dnsService: EverWorksDnsService,
        private readonly subdomainAllocator: SubdomainAllocator,
        private readonly funnel: ZeroFrictionFunnelService,
        // EW-741 — reconcile managed subdomain with `WorkCustomDomain` rows.
        // Both must be served by the Ingress simultaneously: the managed
        // subdomain stays as the primary host, and every active custom
        // domain is appended as an additional Ingress rule via the
        // `extraHosts` settings field. Optional in DI so legacy test
        // fixtures that construct DeployService directly (without the
        // custom-domain repo wired) keep working — the merge code treats
        // a missing repo as "no extras".
        private readonly customDomainRepository?: WorkCustomDomainRepository,
        // Auto-provisions a per-Work database on the shared "Ever Works DB"
        // when the Work is in shared mode and none is set. Optional in DI so
        // fixtures that construct DeployService directly keep working (a
        // missing provider means "don't auto-provision", same as feature-off).
        private readonly dbProvisionService?: EverWorksDbProvisionService,
    ) {}

    /**
     * EW-734 — feature flag gating the collision-safe managed-subdomain
     * extension to the k8s deploy path. When OFF (default), the legacy
     * `applyEverWorksSubdomain` runs as today and the 7 already-deployed
     * k8s Works see zero behavior change. When ON, the deploy path ALSO
     * allocates+persists a unique `*.ever.works` for `deployProvider='k8s'`
     * via `SubdomainAllocator` and uses it as the Ingress host.
     *
     * Read once via the getter — `process.env` mutations between calls
     * (test setups) are respected without touching DI.
     */
    private get isManagedSubdomainForK8sEnabled(): boolean {
        return process.env.K8S_MANAGED_SUBDOMAIN === 'true';
    }

    /**
     * Optional fields that target a preview or scheduled deploy. When all are
     * omitted, this behaves exactly like the original production-only call.
     */
    static buildEnvironmentOptions(opts: DeployOptions): {
        environment: DeploymentEnvironment;
        branch?: string;
        prNumber?: number;
        commitSha?: string;
        codeUpdateId?: string;
        triggerSource: DeploymentTriggerSource;
    } {
        return {
            environment: opts.environment ?? DeploymentEnvironment.PRODUCTION,
            branch: opts.branch,
            prNumber: opts.prNumber,
            commitSha: opts.commitSha,
            codeUpdateId: opts.codeUpdateId,
            triggerSource: opts.triggerSource ?? DeploymentTriggerSource.MANUAL,
        };
    }

    /**
     * Deploy a work using its configured deployment provider.
     *
     * Returns the dispatched flag plus the deployment-history row id so the
     * caller can start verification keyed by environment.
     */
    async deploy(
        workId: string,
        userId: string,
        options: DeployOptions = {},
    ): Promise<DeployResult> {
        const env = DeployService.buildEnvironmentOptions(options);
        const { plugin, token, work, settings, settingSources } =
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
        // - `k8s-works` (internal cluster) is admin-only: requires BOTH
        //   `user.isPlatformAdmin` AND a website repo in the `ever-works` org.
        // - Ever Works-shared GHCR + customer-provided cluster is rejected
        //   to avoid cross-tenant credential exposure.
        // The resolved kubeconfig replaces the user-pasted one for
        // platform-managed sources.
        const effectiveContext = this.resolveDeploymentContext(
            work,
            plugin.id,
            websiteOwner,
            settings ?? {},
            token,
            user,
            settingSources,
        );
        const effectiveDeployToken = effectiveContext.token;

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
        const deploySettings = await this.applyManagedSubdomain(work, effectiveContext.settings);

        // EW — server-side deploy for platform-managed cluster tiers.
        //
        // The GitHub Actions deploy path is structurally unable to reach a
        // platform-managed cluster: our ARC runner pods have no egress to the
        // cluster APIs, and a customer repo runs on GitHub-hosted runners that
        // can never reach a private RFC1918 endpoint. The platform API pod CAN
        // reach them (verified), already holds the kubeconfig, and
        // KubernetesPlugin.deploy() applies the manifests directly — which is
        // exactly what docs/features/k8s-deployment.md promises for the
        // customer default: "No cluster credentials to manage; the platform
        // runs it for you." `custom-kubeconfig` (bring-your-own cluster, incl.
        // forks) keeps the workflow-dispatch path unchanged.
        const serverSide = this.isServerSideManagedDeploy(
            work.deployProvider,
            plugin,
            effectiveContext.settings,
            effectiveDeployToken,
        );

        await this.setRequiredSecrets(ctx, effectiveDeployToken, work, plugin, deploySettings, {
            omitDeployToken: serverSide,
        });
        await this.setKubernetesGhcrPullSecret(ctx, work, userId, plugin);
        await this.setOptionalSecrets(ctx, options.teamScope, gitToken);
        await this.ensureCronSecret(ctx);
        await this.ensureWebhookSecret(ctx, work);
        await this.ensureRuntimeEnv(ctx, work, plugin);

        const template = await this.websiteTemplateResolver.resolveForWork(work);
        const targetBranch = env.branch ?? template.branch;

        const deployment = await this.deploymentRepository.create({
            workId: work.id,
            environment: env.environment,
            provider: plugin.id,
            branch: targetBranch,
            prNumber: env.prNumber,
            commitSha: env.commitSha,
            codeUpdateId: env.codeUpdateId,
            triggerSource: env.triggerSource,
            triggeredByUserId: userId,
            state: 'INITIALIZING',
        });

        // EW-617 G8 — funnel step 6: deploy started. Emit just before the
        // dispatch so the timestamp lines up with the workflow kick-off,
        // not the secret-pushing prep. Gated on correlationId so non-funnel
        // deploys (dashboard "Deploy" button, batch jobs) stay quiet.
        //
        // Fallback: when the caller didn't thread `correlationId` through
        // (e.g. quick-create → WorkGenerationService → … → deploy), use
        // the one persisted on the work by `WorkLifecycleService.createWork`
        // so the funnel chain stays unbroken from REPOS_PUSHED onwards.
        const effectiveCorrelationId =
            options.correlationId || work.lastDeployCorrelationId || undefined;
        if (effectiveCorrelationId) {
            const ingressHostValue =
                deploySettings && typeof deploySettings.ingressHost === 'string'
                    ? deploySettings.ingressHost
                    : null;
            this.funnel.emit({
                event: ZERO_FRICTION_FUNNEL_EVENTS.DEPLOY_STARTED,
                funnelStep: 6,
                timestamp: new Date().toISOString(),
                correlationId: effectiveCorrelationId,
                workId,
                deployProvider: work.deployProvider || 'ever-works',
                ingressHost: ingressHostValue,
            });
        }

        const dispatched = serverSide
            ? await this.deployServerSideManaged({
                  work,
                  userId,
                  plugin,
                  kubeconfig: effectiveDeployToken,
                  gitToken,
                  revision: env.commitSha,
                  deploySettings: deploySettings ?? {},
                  kubeContextOverride: effectiveContext.lookupContext?.kubeContextOverride ?? null,
                  deploymentId: deployment.id,
                  targetBranch,
              })
            : await this.dispatchWithRetry(
                  work,
                  user,
                  gitToken,
                  plugin,
                  env.environment,
                  targetBranch,
                  env.prNumber,
                  env.commitSha,
              );

        if (!dispatched && !serverSide) {
            await this.deploymentRepository.markTerminal(deployment.id, 'ERROR', {
                lastError: 'Workflow dispatch failed',
            });
        }

        // Production deploys also update the legacy Work.deploymentState/website
        // fields so EW-610's DeployProgressPanel and existing consumers keep
        // working without changes.
        if (dispatched && env.environment === DeploymentEnvironment.PRODUCTION) {
            await this.workRepository.update(work.id, {
                deploymentStartedAt: new Date(),
                deploymentState: 'INITIALIZING',
            });
        }

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

        return { dispatched, deploymentId: deployment.id };
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

            const { dispatched, deploymentId } = await this.deploy(workId, userId, { teamScope });

            return {
                workId,
                deploymentId,
                slug: work.slug,
                status: dispatched ? 'pending' : 'error',
                message: dispatched ? 'Deployment started' : 'Failed to initiate deployment',
                owner: work.getRepoOwner('website'),
                repository: `${work.getRepoOwner('website')}/${work.getWebsiteRepo()}`,
            };
        } catch (error: any) {
            return {
                workId,
                slug: 'unknown',
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    private resolveDeploymentContext(
        work: Work,
        pluginId: string | undefined,
        websiteOwner: string,
        settings: Record<string, unknown>,
        resolvedToken: string,
        user: User,
        settingSources?: Readonly<Record<string, SettingSource | undefined>>,
    ): EffectiveDeploymentContext {
        try {
            return resolveEffectiveDeploymentContext({
                deployProvider: work.deployProvider,
                pluginId,
                resolvedToken,
                settings,
                settingSources,
                websiteOwner,
                websiteProjectName: work.getWebsiteRepo(),
                workId: work.id,
                workSlug: work.slug,
                ownerUserId: user.id,
                isPlatformAdmin: Boolean(user.isPlatformAdmin),
            });
        } catch (error) {
            if (!(error instanceof DeploymentContextResolutionError)) throw error;
            if (error.code === 'DEPLOY_MATRIX_VIOLATION' || error.code === 'RESERVED_NAMESPACE') {
                this.logger.warn(
                    `Deploy context rejected${error.reason ? ` [${error.reason}]` : ''}: ${error.message}`,
                );
                throw new BadRequestException(error.message);
            }
            this.logger.error(
                `Cluster-source resolution failed for ${websiteOwner}: ${error.message}`,
            );
            throw new InternalServerErrorException(error.message);
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
     * EW-734 — additive wrapper around the legacy `applyEverWorksSubdomain`.
     *
     * Always runs the legacy path FIRST (zero behavior change for the
     * `'ever-works'` provider and for `'k8s'` deploys whose `work.website`
     * is set). Then, when the `K8S_MANAGED_SUBDOMAIN` env flag is ON,
     * runs the collision-safe `SubdomainAllocator` extension for k8s
     * Works that do NOT already have a derived ingress host. The flag is
     * OFF by default so the 7 already-deployed k8s Works (`dir`,
     * `mcpserver`, `vectordb`, `timetrack`, `chairs`, `startup-books`,
     * `compliance-automation`) see exactly today's behavior; operators opt
     * in per environment.
     *
     * Returns the merged settings (with `ingressHost` set when applicable).
     * Never throws — DNS / allocator failures are logged and the deploy
     * proceeds with the legacy fallback.
     */
    private async applyManagedSubdomain(
        work: Work,
        settings: Record<string, unknown> | undefined,
    ): Promise<Record<string, unknown> | undefined> {
        // (1) Legacy behavior — unchanged. This handles ever-works deploys
        // (CNAME + ingressHost) and k8s deploys with an explicit website.
        const legacy = await this.applyEverWorksSubdomain(work, settings);

        // (1a) EW-741 — reconcile with custom domains. The managed subdomain
        // (whatever `applyEverWorksSubdomain` produced, or the persisted
        // `work.managedSubdomain` resolved below) is the PRIMARY/default host.
        // Every active `WorkCustomDomain` row is appended as an additional
        // Ingress rule via `extraHosts`. The managed subdomain is never
        // removed — adding a custom domain is purely additive (spec §4.6).
        const mergedAfterLegacy = await this.mergeCustomDomainHosts(work, legacy);

        // (2) Gated extension — only fires for k8s + flag ON + no host
        // already resolved by the legacy path. When OFF, this is a no-op
        // and the merged-with-custom-domains result is returned unchanged.
        if (!this.isManagedSubdomainForK8sEnabled) {
            return mergedAfterLegacy;
        }
        if (work.deployProvider !== 'k8s') {
            return mergedAfterLegacy;
        }
        // A non-empty string `ingressHost` in the merged result means the
        // legacy path resolved a host (today: from `work.website` for k8s).
        // Respect it (spec §4.4: an explicit user-set host wins). An
        // empty/whitespace value falls through — Greptile P2 / Augment medium:
        // prior version would skip allocation on any presence of the key,
        // including empty.
        if (
            mergedAfterLegacy &&
            typeof mergedAfterLegacy === 'object' &&
            'ingressHost' in mergedAfterLegacy
        ) {
            const existing = (mergedAfterLegacy as Record<string, unknown>).ingressHost;
            if (typeof existing === 'string' && existing.trim().length > 0) {
                return mergedAfterLegacy;
            }
        }

        // Provider + LB target pre-checks. Greptile P1 + Augment medium:
        // calling `ensureRecord` with an empty `content` left the Work with a
        // persisted `managedSubdomain` and an Ingress pointing at a host that
        // resolves to nothing. Bail BEFORE allocate() so we never persist a
        // claim we can't back with a real CNAME.
        const provider = this.dnsService.getProvider();
        const lbTarget = process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME?.trim() ?? '';
        if (!provider || !lbTarget) {
            this.logger.debug(
                `EW-734 k8s managed-subdomain skipped for work ${work.id}: ` +
                    `provider=${provider ? 'ok' : 'missing'} lbTarget=${lbTarget ? 'ok' : 'missing'}; falling back to legacy host`,
            );
            return mergedAfterLegacy;
        }

        try {
            const allocation = await this.subdomainAllocator.allocate(work);
            // Fire-and-forget DNS record creation, matching the legacy
            // ever-works path's behavior (errors log but never abort).
            void provider
                .ensureRecord({
                    host: allocation.fqdn,
                    type: 'CNAME',
                    target: lbTarget,
                    proxied: false,
                    ttl: 1,
                })
                .catch((cause) => {
                    this.logger.error(
                        `EW-734 k8s managed-subdomain ensureRecord failed for ${allocation.fqdn}: ${(cause as Error).message}`,
                    );
                });
            // EW-741 — when the allocator wins, the previously-merged
            // `extraHosts` (custom domains) must still travel alongside the
            // newly-allocated managed subdomain. We re-dedupe against the
            // fresh ingressHost so the primary host never appears twice.
            const next: Record<string, unknown> = {
                ...(mergedAfterLegacy ?? {}),
                ingressHost: allocation.fqdn,
            };
            const merged = mergedAfterLegacy as Record<string, unknown> | undefined;
            const prior = Array.isArray(merged?.extraHosts) ? (merged.extraHosts as string[]) : [];
            const deduped = this.dedupeExtraHosts(prior, allocation.fqdn);
            if (deduped.length > 0) {
                next.extraHosts = deduped;
            } else {
                delete next.extraHosts;
            }
            return next;
        } catch (cause) {
            this.logger.error(
                `EW-734 k8s managed-subdomain allocation failed for work ${work.id}: ${(cause as Error).message}`,
            );
            return mergedAfterLegacy;
        }
    }

    /**
     * EW-741 — merge `WorkCustomDomain` rows for this Work into the deploy
     * settings as `extraHosts`. The managed subdomain (current `ingressHost`)
     * is always retained as the primary host; custom domains never replace it.
     *
     * Idempotent and side-effect free against the input — returns a shallow
     * copy (or the original `settings` when there are no custom domains).
     * Failures are logged and swallowed: a DB hiccup here must not block a
     * deploy that would otherwise succeed with just the managed subdomain.
     */
    private async mergeCustomDomainHosts(
        work: Work,
        settings: Record<string, unknown> | undefined,
    ): Promise<Record<string, unknown> | undefined> {
        if (!this.customDomainRepository) {
            return settings;
        }
        let domains;
        try {
            domains = await this.customDomainRepository.findByWork(work.id);
        } catch (cause) {
            this.logger.warn(
                `EW-741 custom-domain lookup failed for work ${work.id}: ${(cause as Error).message}`,
            );
            return settings;
        }
        if (!domains || domains.length === 0) {
            return settings;
        }
        const primary =
            settings && typeof (settings as Record<string, unknown>).ingressHost === 'string'
                ? ((settings as Record<string, unknown>).ingressHost as string)
                : undefined;
        const rawHosts = domains.map((row) => row.domain);
        const extras = this.dedupeExtraHosts(rawHosts, primary);
        if (extras.length === 0) {
            return settings;
        }
        return {
            ...(settings ?? {}),
            extraHosts: extras,
        };
    }

    /**
     * Lowercase + trim + drop the primary host + dedupe. Shared by the merge
     * step and the allocator-extension's re-dedupe so the rules stay in one
     * place.
     */
    private dedupeExtraHosts(hosts: readonly string[], primary?: string): string[] {
        const primaryNormalized = primary?.trim().toLowerCase();
        const seen = new Set<string>();
        const out: string[] = [];
        for (const host of hosts) {
            if (typeof host !== 'string') continue;
            const normalized = host.trim().toLowerCase();
            if (!normalized) continue;
            if (primaryNormalized && normalized === primaryNormalized) continue;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            out.push(normalized);
        }
        return out;
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
        // EW-617 G5: the managed `ever-works` provider auto-derives
        // `${slug}.ever.works` and provisions the Cloudflare CNAME.
        if (work.deployProvider === 'ever-works') {
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

        // k8s deploys: the per-Work Ingress host MUST come from the Work's own
        // primary domain, not the k8s plugin's shared `settings.ingressHost`.
        // That setting is a single user-scoped value (last-write-wins), so
        // without this every Work would claim the same host and the Ingress
        // admission webhook rejects the collision. Derive it from `work.website`.
        if (work.deployProvider === 'k8s') {
            const websiteHost = this.deriveIngressHostFromWebsite(work);
            if (websiteHost) {
                return {
                    ...(settings ?? {}),
                    ingressHost: websiteHost,
                };
            }
        }

        return settings;
    }

    /**
     * Parse the routable Ingress host from a Work's `website` URL. Returns
     * `null` for empty/unparseable values or provider placeholder hosts
     * (`*.vercel.app`) that aren't real custom domains, so the caller falls
     * back to the plugin's configured host.
     */
    private deriveIngressHostFromWebsite(work: Work): string | null {
        const raw = work.website?.trim();
        if (!raw) {
            return null;
        }
        try {
            const host = new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase();
            if (!host || host.endsWith('.vercel.app')) {
                return null;
            }
            return host;
        } catch {
            return null;
        }
    }

    private async setRequiredSecrets(
        ctx: RepoContext,
        deployToken: string,
        work: Work,
        plugin?: IDeploymentPlugin,
        settings?: Record<string, unknown>,
        options?: {
            /**
             * Server-side (platform-managed) deploys: the resolved deploy
             * token is the PLATFORM's cluster kubeconfig. It must never be
             * written to the website repo — the documented contract for the
             * managed tiers is "no cluster credentials to manage". Everything
             * else (tenant ids, sync secrets, plugin extras) still pushes, so
             * CI builds keep working unchanged.
             */
            omitDeployToken?: boolean;
        },
    ) {
        const provider = work.deployProvider || EVER_WORKS_DEPLOY_PROVIDER_ID;
        const tokenSecretProvider = plugin?.id || provider;
        try {
            await this.setVariable(ctx, 'DEPLOY_PROVIDER', provider);
        } catch (error: any) {
            this.logger.error(
                `Failed to set DEPLOY_PROVIDER variable for ${ctx.owner}/${ctx.repo}: ${error.message}`,
            );
        }

        await Promise.all([
            this.setSecret(ctx, 'TENANT_ID', work.id),
            this.setSecret(ctx, 'WORK_ID', work.id),
            this.setSecret(ctx, 'DATA_REPOSITORY', work.getDataRepo()),
            ...(options?.omitDeployToken
                ? []
                : [
                      this.setSecret(
                          ctx,
                          this.providerTokenSecretName(tokenSecretProvider),
                          deployToken,
                      ),
                      this.setSecret(ctx, 'DEPLOY_TOKEN', deployToken),
                  ]),
        ]);

        // SITE_URL — used by the deployed site for canonical URLs, sitemap.xml,
        // RSS/Atom self-references, and OpenGraph. Falls back to placeholders
        // when not set, which is fine for builds but bad for SEO on a live site.
        //
        // Pushed as a **GitHub Actions variable** (not a secret) — it is a
        // public URL with no security sensitivity, and storing it as a variable
        // makes it visible in the repo's Settings → Actions UI and easily
        // overridable from the dashboard without a redeploy. Mirrors
        // DEPLOY_PROVIDER's posture.
        //
        // When `applyEverWorksSubdomain` resolved an `ingressHost` (i.e.
        // `deployProvider === 'ever-works'` with Cloudflare DNS configured),
        // SITE_URL is derived from it as `https://${ingressHost}`. For all
        // other providers we leave SITE_URL unset and rely on the template's
        // own fallback (the user can override in the Vercel project's env
        // dashboard, or set SITE_URL in the repo's Variables after the
        // fact).
        const ingressHost = settings?.ingressHost;
        if (typeof ingressHost === 'string' && ingressHost.trim().length > 0) {
            try {
                await this.setVariable(ctx, 'SITE_URL', `https://${ingressHost.trim()}`);
            } catch (error: any) {
                this.logger.error(
                    `Failed to push SITE_URL variable for work ${work.id} on ${ctx.owner}/${ctx.repo}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

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
                } catch (error: any) {
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
            } catch (error: any) {
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
            } catch (error: any) {
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
    private async setKubernetesGhcrPullSecret(
        ctx: RepoContext,
        work: Work,
        userId: string,
        plugin?: IDeploymentPlugin,
    ) {
        if (!this.isKubernetesDeploy(work.deployProvider, plugin?.id)) {
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
            const userRegistryUsername =
                typeof githubSettings?.readPackagesPatOwner === 'string'
                    ? githubSettings.readPackagesPatOwner.trim()
                    : '';

            // Platform-side fallback by website repo owner.
            const platformDefaults = this.getPlatformGhcrCredentials(ctx.owner);

            const classicPat = userClassic || platformDefaults.classic;
            const fineGrainedPat = userFineGrained || platformDefaults.fineGrained;
            const registryUsername =
                userClassic || userFineGrained
                    ? userRegistryUsername || platformDefaults.username || 'x-access-token'
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
        } catch (error: any) {
            // Don't block the deploy on this — the workflow has a safe
            // fallback. Just log so operators can debug if pulls fail.
            this.logger.warn(
                `Failed to push GHCR pull credentials for ${ctx.owner}/${ctx.repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private isKubernetesDeploy(deployProvider?: string, pluginId?: string): boolean {
        return (
            deployProvider === KUBERNETES_DEPLOY_PROVIDER_ID ||
            deployProvider === EVER_WORKS_DEPLOY_PROVIDER_ID ||
            pluginId === KUBERNETES_DEPLOY_PROVIDER_ID
        );
    }

    /**
     * True when this deploy should be applied server-side by the platform
     * instead of dispatched to a GitHub Actions workflow.
     *
     * Conditions, all required:
     *  - kubernetes-family provider (`k8s` or the managed `ever-works`),
     *  - the plugin actually implements `deploy()` (older/lazy plugins may not),
     *  - a non-empty resolved kubeconfig (for managed tiers this is the
     *    platform-held kubeconfig; empty means resolution failed upstream),
     *  - and the work targets a platform-managed cluster: either the managed
     *    `ever-works` provider (always platform-held) or a k8s clusterSource
     *    of `k8s-works` / `k8s-works-shared`. `custom-kubeconfig` stays on
     *    the workflow path — that cluster is reachable from GitHub runners by
     *    definition (the user pasted its kubeconfig for exactly that reason).
     */
    private isServerSideManagedDeploy(
        deployProvider: string | undefined,
        plugin: IDeploymentPlugin | undefined,
        settings: Record<string, unknown>,
        resolvedKubeconfig: string,
    ): boolean {
        if (!this.isKubernetesDeploy(deployProvider, plugin?.id)) return false;
        if (typeof (plugin as { deploy?: unknown } | undefined)?.deploy !== 'function')
            return false;
        if (!resolvedKubeconfig || !resolvedKubeconfig.trim()) return false;
        if (deployProvider === EVER_WORKS_DEPLOY_PROVIDER_ID) return true;
        return coerceDeploymentClusterSource(settings.clusterSource) !== 'custom-kubeconfig';
    }

    /**
     * Apply the work's manifests directly to the managed cluster via
     * KubernetesPlugin.deploy().
     *
     * Image: CI (k8s-build.yml, synced from the template into every website
     * repo) pushes `ghcr.io/<owner>/<WEBSITE-REPO>` tagged with the branch
     * alias (develop→dev, stage→stage, main|master→prod) and with
     * `sha-<full-sha>`. We deploy the alias — see the note at the tag
     * computation for why a short-SHA pin would not resolve.
     *
     * Runtime env: the same values the workflow used to copy out of GitHub
     * secrets are assembled here from their sources of truth and applied as
     * the `<slug>-runtime-env` Secret — they never touch the repo.
     */
    private async deployServerSideManaged(args: {
        work: Work;
        userId: string;
        plugin: IDeploymentPlugin;
        kubeconfig: string;
        gitToken: string;
        deploySettings: Record<string, unknown>;
        kubeContextOverride: string | null;
        deploymentId: string;
        targetBranch: string;
        revision?: string;
    }): Promise<boolean> {
        const {
            work,
            userId,
            plugin,
            kubeconfig,
            gitToken,
            deploySettings,
            kubeContextOverride,
            deploymentId,
            targetBranch,
            revision,
        } = args;
        try {
            // ALWAYS the branch alias — never a commit SHA. `k8s-build.yml`
            // (the workflow that actually publishes these images) pushes exactly
            // two tag shapes:
            //     :<alias>          dev | stage | prod
            //     :sha-<full-sha>   40 hex chars, `sha-` prefixed
            // The bare 12-char SHA tag this used to pin was published by
            // `deploy_k8s.yaml`, which is now gated off — so pinning a short SHA
            // would reference a tag that does not exist and the pod would sit in
            // ImagePullBackOff. `sha-<full>` cannot be used either: the plugin
            // truncates gitSha to 12 chars (see `sanitiseDockerTag` in
            // k8s.plugin.ts), which would mangle it to `sha-abcd1234`.
            // The alias is republished on every push to the branch, so it is
            // both always-present and always-current — the same contract
            // ArgoCD Image Updater relies on elsewhere in this fleet.
            const gitSha = DeployService.branchImageAlias(targetBranch);

            const hosts: string[] = [];
            const ingressHost = deploySettings.ingressHost;
            if (typeof ingressHost === 'string' && ingressHost.trim()) {
                hosts.push(ingressHost.trim());
            }
            const extraHosts = deploySettings.extraHosts;
            if (Array.isArray(extraHosts)) {
                for (const h of extraHosts) {
                    if (typeof h === 'string' && h.trim()) hosts.push(h.trim());
                }
            }

            const ghcrReadToken = await this.resolveGhcrReadToken(work, userId, gitToken);
            const runtimeEnv = await this.collectServerSideRuntimeEnv(work, hosts[0], gitToken);

            const namespace =
                typeof deploySettings.namespace === 'string' && deploySettings.namespace.trim()
                    ? deploySettings.namespace.trim()
                    : undefined;

            const result = await (
                plugin as IDeploymentPlugin & {
                    deploy: (
                        config: DeploymentConfig,
                        kubeconfig: string,
                    ) => Promise<DeploymentResult>;
                }
            ).deploy(
                {
                    // MUST match what DeploymentVerifierService reads back:
                    // it calls lookupExistingDeployment(work.getWebsiteRepo()),
                    // and the plugin names every object sanitiseSlug(projectName).
                    // Naming these after work.slug made the writer and the reader
                    // disagree for every Work whose website repo is <slug>-website
                    // (the default), so verification could never find the
                    // Deployment and every deploy ended TIMEOUT.
                    projectName: work.getWebsiteRepo(),
                    // Required by `DeploymentConfig`. The k8s plugin applies
                    // pre-built manifests and never reads it — there is no
                    // local checkout server-side — so '.' is the same inert
                    // value the plugin's own tests pass.
                    sourceDir: '.',
                    options: {
                        gitSha,
                        githubOwner: work.getRepoOwner('website'),
                        imageName: work.getWebsiteRepo(),
                        namespaceOverride: namespace,
                        kubeContextOverride,
                        hosts,
                        runtimeEnv,
                        // BLOCK-1: without a read:packages token the plugin
                        // resolves visibility 'auto' -> 'private' (it errs on the
                        // safe side when websiteRepoIsPrivate is unknown), mints a
                        // pull secret, finds an empty password and throws
                        // GITHUB_NOT_CONNECTED *before* applying anything. The
                        // workflow path had secrets.GITHUB_TOKEN as a last resort;
                        // this is the server-side equivalent.
                        githubReadPackagesToken: ghcrReadToken,
                        // Annotation only — NEVER the image tag. CI publishes
                        // `sha-<full>`, and the plugin truncates a gitSha to 12
                        // chars, so a SHA can't address the image; it can still
                        // make the pod template differ between deploys.
                        revision: revision,
                        // Per-Work settings (replicas, registry, kubeContext, ...)
                        // never reach the plugin otherwise: its context is built
                        // unscoped, so getSettings() resolves admin -> env ->
                        // schema default and silently discards what the Work set.
                        settingsOverride: deploySettings,
                    },
                },
                kubeconfig,
            );

            if (result?.status === 'error') {
                await this.deploymentRepository.markTerminal(deploymentId, 'ERROR', {
                    lastError: result.error ?? 'Server-side deploy failed',
                });
                this.logger.error(
                    `Server-side deploy failed for work ${work.id}: ${result.error ?? 'unknown error'}`,
                );
                return false;
            }
            this.logger.log(
                `Server-side deploy applied for work ${work.id} (image tag ${gitSha}${
                    hosts[0] ? `, host ${hosts[0]}` : ''
                })`,
            );
            return true;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            await this.deploymentRepository.markTerminal(deploymentId, 'ERROR', {
                lastError: message,
            });
            this.logger.error(`Server-side deploy threw for work ${work.id}: ${message}`);
            return false;
        }
    }

    /** develop→dev, stage→stage, main|master→prod — mirrors k8s-build.yml. */
    private static branchImageAlias(branch: string): string {
        switch (branch) {
            case 'develop':
                return 'dev';
            case 'stage':
                return 'stage';
            case 'main':
            case 'master':
                return 'prod';
            default:
                return branch.replace(/\//g, '-');
        }
    }

    /**
     * The core runtime environment for a server-side deploy — the same values
     * the GitHub Actions path pushed as repo secrets for the workflow to copy
     * into the cluster, assembled from their sources of truth instead.
     * Best-effort per value: a failed lookup logs and omits the key rather
     * than failing the deploy (matching the workflow path's posture).
     */
    private async collectServerSideRuntimeEnv(
        work: Work,
        primaryHost?: string,
        gitToken?: string,
    ): Promise<Record<string, string>> {
        // DATA_REPOSITORY must be a CLONE URL, not a bare repo name. The
        // workflow this replaces rewrote it exactly this way
        // ("DATA_REPOSITORY=https://github.com/<owner>/<repo>"); the running app
        // parses it with zod .url().catch(undefined), so a bare name is silently
        // discarded and the site renders an empty directory while reporting Ready.
        const dataRepo = work.getDataRepo();
        const alreadyQualified =
            dataRepo.startsWith('https://') ||
            dataRepo.startsWith('http://') ||
            dataRepo.startsWith('git@');
        const dataRepositoryUrl = alreadyQualified
            ? dataRepo
            : `https://github.com/${work.getRepoOwner('data').toLowerCase()}/${dataRepo}`;

        const env: Record<string, string> = {
            TENANT_ID: work.id,
            WORK_ID: work.id,
            DATA_REPOSITORY: dataRepositoryUrl,
            COOKIE_SECURE: 'true',
        };
        // GH_TOKEN is not optional: item.repository.ts throws
        // "DATA_REPOSITORY and GH_TOKEN environment variables are required",
        // which kills sync, moderation, /api/items/* and every admin route.
        // envFrom optional:true means its absence fails silently at runtime.
        if (gitToken) env.GH_TOKEN = gitToken;
        if (primaryHost) env.COOKIE_DOMAIN = primaryHost;
        try {
            env.AUTH_SECRET = await this.workRuntimeEnvService.getOrGenerateAuthSecret(work.id);
            env.COOKIE_SECRET = await this.workRuntimeEnvService.getOrGenerateCookieSecret(work.id);
        } catch (error: unknown) {
            this.logger.error(
                `Runtime-env auth/cookie secret generation failed for work ${work.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        try {
            const databaseUrl = await this.workRuntimeEnvService.getDatabaseUrl(work.id);
            if (databaseUrl) env.DATABASE_URL = DeployService.externalizeDatabaseHost(databaseUrl);
        } catch (error: unknown) {
            this.logger.error(
                `Runtime-env DATABASE_URL lookup failed for work ${work.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        if (primaryHost) {
            const url = `https://${primaryHost}`;
            env.SITE_URL = url;
            env.NEXT_PUBLIC_SITE_URL = url;
            env.NEXT_PUBLIC_APP_URL = url;
        }
        // Activity Feed sync — same transport selection as the secret-push path.
        const syncMode = work.activitySyncMode ?? 'pull';
        if (syncMode === 'push') {
            if (process.env.PLATFORM_API_URL && process.env.PLATFORM_API_SECRET_TOKEN) {
                env.PLATFORM_API_URL = process.env.PLATFORM_API_URL;
                env.PLATFORM_API_SECRET_TOKEN = process.env.PLATFORM_API_SECRET_TOKEN;
            }
        } else if (syncMode === 'pull') {
            try {
                env.PLATFORM_SYNC_SECRET = await this.platformSyncSecretService.getOrGenerate(
                    work.id,
                );
            } catch (error: unknown) {
                this.logger.error(
                    `Runtime-env PLATFORM_SYNC_SECRET generation failed for work ${work.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        return env;
    }

    /**
     * The read:packages credential the server-side deploy hands the k8s plugin
     * so it can mint the image-pull Secret for a private GHCR image.
     *
     * Same resolution order `setKubernetesGhcrPullSecret` uses for the workflow
     * path (per-Work GitHub plugin settings -> platform defaults for the repo
     * owner), with the caller's git token as the last resort — the server-side
     * equivalent of the workflow's `secrets.GITHUB_TOKEN` fallback.
     *
     * Never throws: a missing token is not worth failing a deploy that might be
     * pulling a public image, and the plugin raises GITHUB_NOT_CONNECTED with a
     * far better message if it turns out one was needed.
     */
    private async resolveGhcrReadToken(
        work: Work,
        userId: string,
        gitToken?: string,
    ): Promise<string> {
        try {
            const githubSettings = await this.deployFacade.getOtherPluginSettings('github', {
                userId,
                workId: work.id,
            });
            const fineGrained =
                typeof githubSettings?.readPackagesPat === 'string'
                    ? githubSettings.readPackagesPat.trim()
                    : '';
            const classic =
                typeof githubSettings?.readPackagesPatClassic === 'string'
                    ? githubSettings.readPackagesPatClassic.trim()
                    : '';
            // Classic FIRST. Verified 2026-07-31 against
            // ghcr.io/v2/ever-works/awesome-mcp-servers-website/manifests/prod:
            // the fine-grained PAT returns 403, the classic ghp_ one returns 200.
            // Preferring fineGrained would silently re-break image pulls the
            // moment someone adds a fine-grained PAT to the platform secret.
            if (classic || fineGrained) return classic || fineGrained;

            const platformDefaults = this.getPlatformGhcrCredentials(work.getRepoOwner('website'));
            const platformToken = platformDefaults.classic || platformDefaults.fineGrained;
            if (platformToken) return platformToken;
        } catch (error: unknown) {
            this.logger.warn(
                `GHCR read-token lookup failed for work ${work.id}; falling back to the git token: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return gitToken ?? '';
    }

    /**
     * Rewrite an in-cluster Postgres host to the address a Work can actually
     * reach from ITS OWN cluster.
     *
     * The platform runs on ever-k8s and talks to Postgres over the in-cluster
     * service DNS (`pg-rw.databases.svc.cluster.local`). A Work deployed to
     * k8s-works / k8s-works-shared is on a DIFFERENT cluster, where that name
     * does not resolve at all — verified from inside a Work pod on
     * k8s-works-shared: ENOTFOUND, while the LoadBalancer address connects.
     * Handing the Work the platform's own URL made it die on startup with
     * "Database initialization failed", which reads like a migration bug and is
     * really a DNS one.
     *
     * `DB_EVER_WORKS_SHARED_HOST` already carries the externally-reachable
     * address for exactly this purpose; this only swaps host:port and leaves
     * credentials, database name and query string untouched. No-op when the
     * host is not an in-cluster name (custom-kubeconfig Works pointing at their
     * own database keep working unchanged).
     */
    static externalizeDatabaseHost(databaseUrl: string): string {
        const externalHost = (process.env.DB_EVER_WORKS_SHARED_HOST || '').trim();
        if (!externalHost) return databaseUrl;
        let parsed: URL;
        try {
            parsed = new URL(databaseUrl);
        } catch {
            return databaseUrl;
        }
        if (!parsed.hostname.endsWith('.svc.cluster.local') && !parsed.hostname.endsWith('.svc')) {
            return databaseUrl;
        }
        parsed.hostname = externalHost;
        const externalPort = (process.env.DB_EVER_WORKS_SHARED_PORT || '').trim();
        if (externalPort) parsed.port = externalPort;
        const sslMode = (process.env.DB_EVER_WORKS_SHARED_SSLMODE || '').trim();
        if (sslMode && !parsed.searchParams.has('sslmode')) {
            parsed.searchParams.set('sslmode', sslMode);
        }
        return parsed.toString();
    }

    private providerTokenSecretName(providerId: string): string {
        const normalised = providerId.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        return `${normalised}_TOKEN`;
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
            promises.push(this.setSecret(ctx, 'VERCEL_TEAM_SCOPE', teamScope));
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

    /**
     * Provision the per-Work `WEBHOOK_SECRET` so the deployed site's
     * content-sync webhook endpoint can verify incoming GitHub push
     * notifications. The minimal template's `@ever-works/astro-integration`
     * reads this from `process.env.WEBHOOK_SECRET` at build time and
     * registers a verifying `/api/webhook` endpoint iff defined; classic
     * template ignores it. Pushed on every deploy (harmless on templates
     * that don't consume it, required on templates that do).
     *
     * **Persistence**: the secret value is read from (and lazily provisioned
     * onto) `Work.webhookSecretEncrypted` via `WebhookSecretService` so the
     * same plaintext is pushed across every deploy of the same Work. Rotating
     * on every deploy would silently invalidate the GitHub-side webhook
     * registration — every payload would fail X-Hub-Signature-256 verification
     * until the workflow re-registered the webhook. The persistence pattern
     * mirrors `PlatformSyncSecretService` for the EW-120 pull-mode HMAC.
     *
     * Failure is logged but not thrown — webhook verification degrades to
     * "polling-only" rather than blocking the deploy.
     */
    private async ensureWebhookSecret(ctx: RepoContext, work: Work) {
        try {
            const webhookSecret = await this.webhookSecretService.getOrGenerate(work.id);
            await this.setSecret(ctx, 'WEBHOOK_SECRET', webhookSecret);
        } catch (error: any) {
            this.logger.warn(
                `Failed to push WEBHOOK_SECRET for ${ctx.owner}/${ctx.repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Provision the per-Work application runtime env that a k8s-deployed
     * directory site needs to boot in production. Vercel supplied these from
     * project env + the external Postgres integration; k8s has no such source, so without
     * this the deployed site 500s (`[auth] AUTH_SECRET must be set in
     * production`). Pushed as GitHub secrets; `deploy_k8s.yaml` materializes
     * them into a `${slug}-runtime-env` k8s Secret the Deployment mounts via
     * `envFrom`. No-op for non-k8s providers (Vercel manages its own env).
     *
     * `AUTH_SECRET`/`COOKIE_SECRET` are generated once and persisted (stable
     * across redeploys — rotating would drop every live session). `DATABASE_URL`
     * is the per-Work Postgres (e.g. reused external Postgres) connection string when
     * configured. `NEXT_PUBLIC_APP_URL`/`COOKIE_DOMAIN` are derived from the
     * ingress host inside the manifest, not here.
     */
    private async ensureRuntimeEnv(ctx: RepoContext, work: Work, plugin?: IDeploymentPlugin) {
        if (!this.isKubernetesDeploy(work.deployProvider, plugin?.id)) {
            return;
        }
        try {
            await this.setSecret(
                ctx,
                'AUTH_SECRET',
                await this.workRuntimeEnvService.getOrGenerateAuthSecret(work.id),
            );
            await this.setSecret(
                ctx,
                'COOKIE_SECRET',
                await this.workRuntimeEnvService.getOrGenerateCookieSecret(work.id),
            );
            await this.setSecret(ctx, 'COOKIE_SECURE', 'true');

            let databaseUrl = await this.workRuntimeEnvService.getDatabaseUrl(work.id);
            // PostgreSQL DB plugin is the source of truth for per-Work DB
            // config: resolve from its settings (work-scoped override >
            // user-scoped custom server > managed "Ever Works DB"). Wrapped so a
            // missing/unloaded plugin (e.g. older image) falls through to the
            // legacy mode-based path below rather than failing the deploy.
            if (!databaseUrl && this.dbProvisionService) {
                try {
                    const pgSettings = await this.deployFacade.getOtherPluginSettings(
                        'postgres-db',
                        { userId: work.userId, workId: work.id },
                    );
                    databaseUrl = await this.dbProvisionService.resolveFromPluginSettings(
                        work.id,
                        pgSettings,
                    );
                } catch (pluginError) {
                    this.logger.debug(
                        `postgres-db plugin settings unavailable for work ${work.id}; using legacy DB resolution: ${
                            pluginError instanceof Error ? pluginError.message : String(pluginError)
                        }`,
                    );
                }
            }
            // Legacy fallback — shared "Ever Works DB": auto-provision a per-Work
            // database on the first deploy when none is set and the Work isn't
            // explicitly using a custom connection string. No-op when the feature
            // isn't wired (isReady() false) or the Work already has a URL.
            if (!databaseUrl && this.dbProvisionService?.isReady()) {
                const mode = await this.workRuntimeEnvService.getDatabaseMode(work.id);
                if (mode !== 'custom') {
                    try {
                        databaseUrl = await this.dbProvisionService.ensureDatabaseForWork(work.id);
                        if (databaseUrl && !mode) {
                            await this.workRuntimeEnvService.setDatabaseMode(work.id, 'shared');
                        }
                    } catch (provisionError) {
                        this.logger.warn(
                            `Shared DB provision failed for work ${work.id}: ${
                                provisionError instanceof Error
                                    ? provisionError.message
                                    : String(provisionError)
                            }`,
                        );
                    }
                }
            }
            if (databaseUrl) {
                await this.setSecret(ctx, 'DATABASE_URL', databaseUrl);
            } else {
                this.logger.warn(
                    `No DATABASE_URL configured for work ${work.id}; DB-backed features (auth users, favorites, submissions) will be unavailable on k8s until one is set.`,
                );
            }
        } catch (error: any) {
            this.logger.warn(
                `Failed to push runtime env for ${ctx.owner}/${ctx.repo}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private generateSecureToken(): string {
        return randomBytes(this.CRON_SECRET_LENGTH).toString('hex');
    }

    private async findMissingWorkflowFiles(
        owner: string,
        repo: string,
        token: string,
        branch: string,
        workflowFiles: readonly string[],
    ): Promise<string[] | null> {
        const plugin = this.getGitHubPlugin();
        if (typeof plugin.getFileContent !== 'function') {
            return null;
        }

        const missing: string[] = [];
        for (const workflowFile of workflowFiles) {
            const workflowPath = `.github/workflows/${workflowFile}`;
            try {
                await plugin.getFileContent(owner, repo, workflowPath, token, branch);
            } catch (error: any) {
                if (this.isRepositoryFileNotFound(error)) {
                    missing.push(workflowFile);
                    continue;
                }

                this.logger.warn(
                    `Could not preflight workflow file "${workflowPath}" in ${owner}/${repo}@${branch}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                return null;
            }
        }

        return missing;
    }

    private isRepositoryFileNotFound(error: unknown): boolean {
        const maybeError = error as {
            status?: number;
            response?: { status?: number };
            message?: string;
        };
        const status = maybeError?.status ?? maybeError?.response?.status;
        if (status === 404) return true;

        return typeof maybeError?.message === 'string' && /not found/i.test(maybeError.message);
    }

    private async areAllWorkflowFilesMissing(params: {
        owner: string;
        repo: string;
        token: string;
        branch: string;
        workflowFiles: readonly string[];
        phase: 'initial' | 'post-update';
    }): Promise<boolean> {
        const missing = await this.findMissingWorkflowFiles(
            params.owner,
            params.repo,
            params.token,
            params.branch,
            params.workflowFiles,
        );

        if (!missing || missing.length === 0) {
            return false;
        }

        const missingList = missing.join(', ');
        if (missing.length === params.workflowFiles.length) {
            this.logger.warn(
                `Deployment workflow preflight (${params.phase}) found no configured workflow files in ${params.owner}/${params.repo}@${params.branch}: ${missingList}`,
            );
            return true;
        }

        this.logger.warn(
            `Deployment workflow preflight (${params.phase}) found missing optional workflow file(s) in ${params.owner}/${params.repo}@${params.branch}: ${missingList}`,
        );
        return false;
    }

    private async dispatchWithRetry(
        work: Work,
        user: User,
        gitToken: string,
        plugin?: IDeploymentPlugin,
        environment: DeploymentEnvironment = DeploymentEnvironment.PRODUCTION,
        branchOverride?: string,
        prNumber?: number,
        commitSha?: string,
    ): Promise<boolean> {
        // The plugin may be a lazy proxy (EW-693 dynamic distribution) that
        // wraps every method call to return a Promise so it can materialize
        // the real plugin on first use. `getWorkflowFilenames` is declared
        // synchronous, so without normalizing here the value reaching the
        // `for…of` in findMissingWorkflowFiles would be a Promise (or
        // `undefined` when the proxy over-reports a method the underlying
        // plugin lacks) — which threw `TypeError: workflowFiles is not
        // iterable` and blocked every k8s deploy. `Promise.resolve` collapses
        // both the sync-array and proxied-Promise cases; the Array guard falls
        // back to the defaults if the result is still not a usable list.
        const rawWorkflowFiles = plugin?.getWorkflowFilenames
            ? await Promise.resolve(plugin.getWorkflowFilenames())
            : [...DEFAULT_WORKFLOW_FILES];
        const workflowFilesToTry =
            Array.isArray(rawWorkflowFiles) && rawWorkflowFiles.length > 0
                ? rawWorkflowFiles
                : [...DEFAULT_WORKFLOW_FILES];
        const owner = work.getRepoOwner('website');
        const repo = work.getWebsiteRepo();
        const template = await this.websiteTemplateResolver.resolveForWork(work);
        const dispatchBranch = branchOverride ?? template.branch;

        const inputs: Record<string, string> = { environment };
        if (prNumber !== undefined) {
            inputs.pr_number = String(prNumber);
        }
        if (commitSha) {
            inputs.commit_sha = commitSha;
        }

        const tryDispatch = async (): Promise<boolean> => {
            for (const workflowFile of workflowFilesToTry) {
                try {
                    this.logger.log(
                        `Attempting to dispatch workflow "${workflowFile}" for ${owner}/${repo} on ${dispatchBranch} (${environment})`,
                    );

                    await this.dispatchWorkflow(
                        {
                            workflow: workflowFile,
                            inputs,
                            branch: dispatchBranch,
                            owner,
                            repo,
                        },
                        gitToken,
                    );

                    this.logger.log(
                        `Successfully dispatched workflow "${workflowFile}" for ${owner}/${repo}`,
                    );
                    return true;
                } catch (error: any) {
                    this.logger.warn(
                        `Failed to dispatch workflow "${workflowFile}" for ${owner}/${repo}: ${error.message}`,
                    );
                }
            }
            return false;
        };

        // First attempt. If the repo is missing every expected workflow,
        // skip the doomed dispatch and sync from the selected template first.
        const skipFirstAttempt = await this.areAllWorkflowFilesMissing({
            owner,
            repo,
            token: gitToken,
            branch: dispatchBranch,
            workflowFiles: workflowFilesToTry,
            phase: 'initial',
        });
        const firstAttemptSuccess = skipFirstAttempt ? false : await tryDispatch();
        if (firstAttemptSuccess) {
            return true;
        }

        // If dispatch fails, update the repository
        try {
            this.logger.log(`Workflow dispatch failed. Updating repository for ${owner}/${repo}`);
            await this.websiteUpdateService.updateRepository(work, user);
            await this.createTriggerCommit(work, user);
            await this.delay(3000);

            const stillMissingAllWorkflows = await this.areAllWorkflowFilesMissing({
                owner,
                repo,
                token: gitToken,
                branch: dispatchBranch,
                workflowFiles: workflowFilesToTry,
                phase: 'post-update',
            });
            if (stillMissingAllWorkflows) {
                this.logger.error(
                    `Deployment cannot continue because ${owner}/${repo}@${dispatchBranch} does not contain any expected deployment workflow: ${workflowFilesToTry.join(', ')}`,
                );
                return false;
            }

            const retrySuccess = await tryDispatch();
            if (retrySuccess) {
                return true;
            }

            this.logger.warn(`Workflow dispatch still failed after updating ${owner}/${repo}`);
            return false;
        } catch (error: any) {
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
        } catch (error: any) {
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
