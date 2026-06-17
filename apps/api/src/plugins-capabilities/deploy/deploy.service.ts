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
import { EverWorksDnsService, SubdomainAllocator } from '@ever-works/agent/ever-works-providers';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';
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

const KUBERNETES_DEPLOY_PROVIDER_ID = 'k8s';
const EVER_WORKS_DEPLOY_PROVIDER_ID = 'ever-works';

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
        return process.env.EW734_K8S_MANAGED_SUBDOMAIN === 'true';
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
            plugin.id,
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
        const deploySettings = await this.applyManagedSubdomain(work, settings);
        await this.setRequiredSecrets(ctx, effectiveDeployToken, work, plugin, deploySettings);
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

        const dispatched = await this.dispatchWithRetry(
            work,
            user,
            gitToken,
            plugin,
            env.environment,
            targetBranch,
            env.prNumber,
            env.commitSha,
        );

        if (!dispatched) {
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

    /**
     * EW-616: Apply the deploy-matrix validation for the k8s provider and
     * substitute the platform's kubeconfig env var when the user picked a
     * platform-managed cluster source. For non-k8s providers (Vercel, etc.)
     * this is a pass-through and the validation is skipped.
     */
    private resolveDeployToken(
        deployProvider: string | undefined,
        pluginId: string | undefined,
        websiteOwner: string,
        settings: Record<string, unknown>,
        userToken: string,
    ): string {
        if (!this.isKubernetesDeploy(deployProvider, pluginId)) {
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
            this.logger.warn(`Deploy-matrix violation [${failure.code}]: ${failure.message}`);
            throw new BadRequestException(failure.message);
        }

        try {
            return resolveKubeconfigForClusterSource(clusterSource, realUserToken);
        } catch (error: any) {
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
     * EW-734 — additive wrapper around the legacy `applyEverWorksSubdomain`.
     *
     * Always runs the legacy path FIRST (zero behavior change for the
     * `'ever-works'` provider and for `'k8s'` deploys whose `work.website`
     * is set). Then, when the `EW734_K8S_MANAGED_SUBDOMAIN` env flag is ON,
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
            this.setSecret(ctx, this.providerTokenSecretName(tokenSecretProvider), deployToken),
            this.setSecret(ctx, 'DEPLOY_TOKEN', deployToken),
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
     * project env + the Neon integration; k8s has no such source, so without
     * this the deployed site 500s (`[auth] AUTH_SECRET must be set in
     * production`). Pushed as GitHub secrets; `deploy_k8s.yaml` materializes
     * them into a `${slug}-runtime-env` k8s Secret the Deployment mounts via
     * `envFrom`. No-op for non-k8s providers (Vercel manages its own env).
     *
     * `AUTH_SECRET`/`COOKIE_SECRET` are generated once and persisted (stable
     * across redeploys — rotating would drop every live session). `DATABASE_URL`
     * is the per-Work Postgres (e.g. reused Neon) connection string when
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

            const databaseUrl = await this.workRuntimeEnvService.getDatabaseUrl(work.id);
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
