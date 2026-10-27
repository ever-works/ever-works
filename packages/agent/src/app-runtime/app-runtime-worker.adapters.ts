/**
 * APW-06 T71 / T73 / T44 / T28 / T29 (A0.7, 2026-10-17) — **the real implementations behind the
 * isolated App runtime worker's remaining ports**.
 *
 * `TriggerAppRuntimeModule` bound the §6.4 ports to `default-ports.ts`'s fail-closed classes and
 * left eight seams unbound, so every dequeued Deployment stopped before it reached the cluster.
 * Each class below is the narrow, real answer for one of those seams. They live in the agent
 * package (not in `packages/tasks`) so the API-side halves sit beside the worker-side halves and a
 * spec can construct them without a Nest context.
 *
 * | Class | Token | Process |
 * | --- | --- | --- |
 * | `ConfigAppsTierPolicy` (moved to `../apps-tier/config-apps-tier-policy.ts`, R-5) | `APPS_TIER_POLICY` | worker + API |
 * | {@link AppBuildPullCredentialSource} | `APP_IMAGE_PULL_CREDENTIAL_SOURCE` | worker |
 * | {@link AppRuntimeTargetAdapter} | `APP_RUNTIME_TARGET` | worker |
 * | {@link AppRuntimeNotificationProducersAdapter} | `APP_RUNTIME_NOTIFICATIONS` | worker (writes via the proxied `NotificationService`) |
 * | {@link PublicGitHubCommitAncestry} | `APP_COMMIT_ANCESTRY` | worker |
 * | {@link AppRuntimeEventRelayService} | — (the API end of `APP_RUNTIME_EVENT_SINK`) | API |
 * | {@link AppDeployDispatchRelay} | — (the API end of the worker's `APP_DEPLOY_DISPATCHER`) | API |
 *
 * None of them holds a credential longer than one call, and none logs one.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppLimitRangeInput, AppTargetRef } from '@ever-works/plugin';

import { NotificationCategory, NotificationType } from '../entities/notification.types';
import type { AppDeployBuildSource } from './app-deploy-preconditions.service';
import { APP_DEPLOY_DISPATCHER } from './app-deploy-request.service';
import {
    APP_CLUSTER_OP_DISPATCHER,
    type AppWorkDeletionCompletion,
    type AppWorkDeletionCompletionReport,
} from './app-runtime-deletion.service';
import type {
    AppCommitAncestry,
    AppDeployOrchestratorDispatcher,
    AppRuntimeNotificationProducers,
} from './app-deploy.orchestrator';
import { parseBearerChallenge, parseImageReference } from './app-image-reference.resolver';
import { describeDependencyError } from '../app-dependencies/describe-dependency-error';
import {
    AppPortUnavailableError,
    AppPullCredentialRefusedError,
    type AppImagePullCredentialContext,
    type AppImagePullCredentialSource,
    type AppRuntimeEventSink,
    type AppRuntimeTargetPort,
    type AppRuntimeTargetUnavailable,
} from './ports';

/* -------------------------------------------------------------------------- *
 * APPS_TIER_POLICY — APW-10's minimal policy (T44)
 * -------------------------------------------------------------------------- */

// `ConfigAppsTierPolicy` and its env helpers live in `../apps-tier/config-apps-tier-policy.ts`
// (Resolution R-5: the policy that reads the managed-tier ceiling is APW-10's, never this
// folder's). `./index.ts` re-exports it, so `@ever-works/agent/app-runtime` still carries it.

/* -------------------------------------------------------------------------- *
 * APP_IMAGE_PULL_CREDENTIAL_SOURCE — a Build's image (T73)
 * -------------------------------------------------------------------------- */

/** The Work facts the pull-credential source reads. */
export interface AppPullCredentialWorkView {
    id: string;
    userId?: string | null;
    gitProvider?: string | null;
    owner?: string | null;
}

/** `GitFacadeService.getAccessToken`, as far as this source reads it. */
export interface AppPullCredentialGitTokens {
    getAccessToken(options: {
        userId: string;
        providerId: string;
        workId?: string;
    }): Promise<string | null>;
    /**
     * Security (sec/app-works-gates) — `GitFacadeService.getWorkInstallationPackagesReadToken`: a
     * GitHub App installation token minted with `permissions: { packages: 'read' }` ONLY, for a
     * Work linked through the platform GitHub App. `null` when the Work is not App-linked, the App
     * credentials are unset, or GitHub refuses the narrowed mint (the App does not hold
     * `Packages: read`). Optional: a binding without it keeps `getAccessToken`'s answer.
     */
    getWorkInstallationPackagesReadToken?(options: {
        userId: string;
        providerId: string;
        workId?: string;
    }): Promise<string | null>;
}

/**
 * Security (sec/app-works-gates, 2026-10-18) — the operator switch that lets the OWNER's git token
 * be the fallback image-pull credential on **your cluster**. Default **off**: on only when the value
 * is exactly `true`. Read per call.
 */
export const APP_PULL_OWNER_TOKEN_FALLBACK_ENV = 'APP_PULL_OWNER_TOKEN_FALLBACK';

/** `APP_PULL_OWNER_TOKEN_FALLBACK` — `true` only for the exact string `'true'` (default off). */
export function appPullOwnerTokenFallbackEnabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return env?.[APP_PULL_OWNER_TOKEN_FALLBACK_ENV] === 'true';
}

/** The member-facing refusal when the switch is off (your cluster, private image, no pull token). */
export const APP_PULL_OWNER_TOKEN_REFUSED_MESSAGE =
    'No read-only pull token is stored for this App and its image is private. Store a read-only ' +
    "pull token on the Builds tab — the owner's GitHub token is not sent to your cluster.";

/** The member-facing refusal when the switch is on but this Deployment may not use the fallback. */
export const APP_PULL_OWNER_TOKEN_NOT_OWNER_SESSION_MESSAGE =
    "No read-only pull token is stored for this App and its image is private. The owner's GitHub " +
    'token is sent to your cluster only for a Deployment the Work owner starts themselves while ' +
    'signed in, and this one was not. Store a read-only pull token on the Builds tab.';

type FetchLike = (
    input: string,
    init?: Record<string, unknown>,
) => Promise<{
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
}>;

/**
 * The pull credential of a **Build's** image (APW-05 pushes it to
 * `ghcr.io/<owner>/<repo>/ever-works-app`).
 *
 * 1. The image is probed anonymously (the registry's own token dance, the same as T72's
 *    resolver). Pullable without a credential ⇒ `null` — "a public image", and nothing is
 *    written to the cluster.
 * 2. Otherwise the owner's stored, read-only pull token (APW-05 T17) wins.
 * 3. Otherwise, for `ghcr.io`, the **owner-token fallback**: a `packages: read`-only GitHub App
 *    installation token when the Work is App-linked and GitHub grants that narrowed mint, else the
 *    App Work owner's git access token (`getAccessToken`: the Work's full GitHub App installation
 *    token when linked, else the owner's connected OAuth account with `repo`, else a settings PAT).
 *    Logged by name only.
 *
 *    🛑 Security (sec/app-works-gates, 2026-10-18): the fallback is rendered as an
 *    `imagePullSecret` into the TARGET cluster, and an editor can repoint a your-cluster target.
 *    So for any target that is not `ever-works-apps` (fail-closed: a missing or unknown target is
 *    treated as your cluster) the fallback is refused with a member-facing
 *    `pull_credential_unavailable` unless `APP_PULL_OWNER_TOKEN_FALLBACK=true` AND the Deployment
 *    was requested by the Work owner from a signed-in session. A Build-triggered (or any
 *    person-less) Deployment never gets it there. The managed tier keeps today's behaviour.
 * 4. Anything else refuses with `pull_credential_unavailable`, which the render-input builder
 *    turns into the precondition of the same name.
 */
export class AppBuildPullCredentialSource implements AppImagePullCredentialSource {
    private readonly logger = new Logger(AppBuildPullCredentialSource.name);

    constructor(
        private readonly builds: AppDeployBuildSource | undefined,
        private readonly works:
            | { findById(id: string): Promise<AppPullCredentialWorkView | null> }
            | undefined,
        private readonly git: AppPullCredentialGitTokens | undefined,
        private readonly fetchImpl?: FetchLike,
        // Lane aw-deploy-3 — APW-05 T17's stored, read-only registry pull token (preferred).
        private readonly storedTokens?: {
            read(workId: string): Promise<{ token: string; username?: string | null } | null>;
        },
    ) {}

    /**
     * Which credential the last `resolve` used for a Work: `public` (none), `pull-token` (APW-05's
     * stored token) or `owner-token` (the fallback — the `packages: read` installation mint or the
     * owner's git token). The render-input builder reads it and records the warning
     * `pull_credential_owner_token` on the Deployment when the fallback was used.
     */
    readonly lastSource = new Map<string, 'public' | 'pull-token' | 'owner-token'>();

    async resolve(
        workId: string,
        buildId: string,
        context?: AppImagePullCredentialContext,
    ): Promise<{ server: string; username: string; password: string } | null> {
        // A refusal below must not leave an earlier resolve's answer to be read as this one's.
        this.lastSource.delete(workId);
        const build = this.builds ? await this.builds.getBuild(workId, buildId) : null;
        const reference = typeof build?.imageReference === 'string' ? build.imageReference : '';
        const parsed = parseImageReference(reference);
        if (!parsed) {
            throw new AppPortUnavailableError(
                'pull_credential_unavailable',
                `Build ${buildId} names no pullable image reference.`,
                `${workId}:${buildId}`,
            );
        }

        if (
            await this.isPublic(
                parsed.registry,
                parsed.repository,
                parsed.tag ?? parsed.digest ?? 'latest',
            )
        ) {
            this.lastSource.set(workId, 'public');
            return null;
        }

        // Lane aw-deploy-3 — the owner's stored read-only pull token wins (APW-05 T17, §4.12): it
        // is scoped to the image, where the GitHub token is the member's whole account.
        const stored = this.storedTokens?.read
            ? await this.storedTokens.read(workId).catch(() => null)
            : null;
        if (stored?.token) {
            const owner = this.works ? await this.works.findById(workId).catch(() => null) : null;
            this.lastSource.set(workId, 'pull-token');
            this.logger.log(
                `App Work ${workId}: pulling the private Build image with the stored pull token.`,
            );
            return {
                server: parsed.registry,
                username:
                    (stored.username && String(stored.username)) ||
                    (owner?.owner && String(owner.owner)) ||
                    parsed.repository.split('/')[0] ||
                    'x-access-token',
                password: stored.token,
            };
        }

        if (parsed.registry !== 'ghcr.io') {
            throw new AppPortUnavailableError(
                'pull_credential_unavailable',
                `No pull credential is known for the registry ${parsed.registry}.`,
                `${workId}:${buildId}`,
            );
        }

        // ---- the owner-token fallback, gated by target (sec/app-works-gates) ------------------
        // Only the managed tier keeps it unconditionally. Every other value — `your-cluster`,
        // `none`, an unknown string, or no context at all — is treated as your cluster.
        const managedTier = context?.target === 'ever-works-apps';

        if (!managedTier && !appPullOwnerTokenFallbackEnabled()) {
            this.logger.warn(
                `App Work ${workId}: private Build image, no stored pull token, and the owner-token ` +
                    `fallback is off for your-cluster targets (${APP_PULL_OWNER_TOKEN_FALLBACK_ENV}); refused.`,
            );
            throw new AppPullCredentialRefusedError(
                APP_PULL_OWNER_TOKEN_REFUSED_MESSAGE,
                `${workId}:${buildId}`,
            );
        }

        const work = this.works ? await this.works.findById(workId) : null;
        const userId = work?.userId ? String(work.userId) : '';

        if (!managedTier && !ownerRequestedFromSession(context, userId)) {
            this.logger.warn(
                `App Work ${workId}: the owner-token fallback is on, but this Deployment was not ` +
                    'requested by the Work owner from a signed-in session; refused.',
            );
            throw new AppPullCredentialRefusedError(
                APP_PULL_OWNER_TOKEN_NOT_OWNER_SESSION_MESSAGE,
                `${workId}:${buildId}`,
            );
        }

        const tokenOptions = {
            userId,
            providerId: work?.gitProvider ? String(work.gitProvider) : 'github',
            workId,
        };
        // Prefer the narrowest credential the platform can mint for the owner: a GitHub App
        // installation token limited to `packages: read`. `null` (not App-linked, App credentials
        // unset, or the App does not hold `Packages: read`) falls back to today's token.
        let scoped = false;
        let token: string | null = null;
        if (userId && this.git?.getWorkInstallationPackagesReadToken) {
            token = await this.git
                .getWorkInstallationPackagesReadToken(tokenOptions)
                .catch(() => null);
            scoped = Boolean(token);
        }
        if (!token && userId && this.git) {
            token = await this.git.getAccessToken(tokenOptions);
        }

        if (!token) {
            throw new AppPortUnavailableError(
                'pull_credential_unavailable',
                `The image of Build ${buildId} is private and the App Work owner has no usable GitHub token.`,
                `${workId}:${buildId}`,
            );
        }

        this.lastSource.set(workId, 'owner-token');
        this.logger.warn(
            `App Work ${workId}: no pull token is stored, so the private Build image is pulled with the owner's ` +
                `${scoped ? 'packages:read GitHub App installation token' : 'GitHub token'} ` +
                `(target ${managedTier ? 'ever-works-apps' : 'your-cluster'}; name only).`,
        );
        return {
            server: 'ghcr.io',
            username:
                (work?.owner && String(work.owner)) ||
                parsed.repository.split('/')[0] ||
                'x-access-token',
            password: token,
        };
    }

    /** One anonymous manifest `HEAD` (with the anonymous-token retry); any failure ⇒ "not public". */
    private async isPublic(registry: string, repository: string, ref: string): Promise<boolean> {
        const fetchImpl: FetchLike =
            this.fetchImpl ?? ((globalThis as unknown as { fetch: FetchLike }).fetch as FetchLike);
        const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry;
        const url = `https://${host}/v2/${repository}/manifests/${ref}`;
        const accept =
            'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, ' +
            'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';

        try {
            let answer = await fetchImpl(url, { method: 'HEAD', headers: { Accept: accept } });
            if (answer.status === 401) {
                const challenge = parseBearerChallenge(answer.headers.get('www-authenticate'));
                if (!challenge) return false;
                const query = new URLSearchParams();
                if (challenge.service) query.set('service', challenge.service);
                query.set('scope', challenge.scope || `repository:${repository}:pull`);
                const tokenAnswer = (await fetchImpl(`${challenge.realm}?${query.toString()}`, {
                    method: 'GET',
                })) as Awaited<ReturnType<FetchLike>> & { json?: () => Promise<unknown> };
                if (!tokenAnswer.ok || typeof tokenAnswer.json !== 'function') return false;
                const body = (await tokenAnswer.json().catch(() => null)) as {
                    token?: string;
                } | null;
                if (!body?.token) return false;
                answer = await fetchImpl(url, {
                    method: 'HEAD',
                    headers: { Accept: accept, Authorization: `Bearer ${body.token}` },
                });
            }
            return answer.ok;
        } catch {
            return false;
        }
    }
}

/**
 * Security (sec/app-works-gates) — `true` only when the Deployment's own row says the Work OWNER
 * requested it from a signed-in session. A missing context, a missing requester (a Build- or
 * event-triggered Deployment), an unknown owner, a different person (an editor) or anything but a
 * literal `true` session flag all answer `false`.
 */
function ownerRequestedFromSession(
    context: AppImagePullCredentialContext | undefined,
    ownerUserId: string,
): boolean {
    const requester =
        typeof context?.requestedByUserId === 'string' ? context.requestedByUserId.trim() : '';
    if (!requester || !ownerUserId) return false;
    if (requester !== ownerUserId) return false;
    return context?.requestedByHumanSession === true;
}

/* -------------------------------------------------------------------------- *
 * APP_RUNTIME_TARGET — the dependency target (T73, §9.9)
 * -------------------------------------------------------------------------- */

/** `AppRuntimeFacadeService.resolveClusterAccess`, as far as this adapter reads it. */
export interface AppRuntimeTargetAccessSource {
    resolveClusterAccess(workId: string): Promise<
        | {
              outcome: 'access';
              access: { ref: AppTargetRef; credential: string; plugin: unknown };
          }
        | { outcome: 'refused'; refusal: string }
    >;
}

/** The labels every App pod carries (`packages/plugins/k8s/src/app/app-names.ts` `appLabels`). */
export function appDependencyPodLabels(workId: string): Record<string, string> {
    return { 'ever-works.io/work-id': String(workId), 'ever-works.io/kind': 'app' };
}

/** The limit range a dependency namespace gets on Your cluster (the renderer's default). */
const DEPENDENCY_NAMESPACE_LIMIT_RANGE: AppLimitRangeInput = {
    defaultRequest: { cpu: '100m', memory: '128Mi' },
    defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
    max: { cpu: '2', memory: '4Gi' },
};

/**
 * §9.9's `prepareDependencyTarget`: the App Work's cluster access through T20's facade (the one
 * place a credential is assembled), then the plugin's `prepareAppNamespace` so APW-07's provider
 * is handed a namespace whose baseline policies already exist — which is what breaks the
 * namespace↔dependency ordering cycle (GAP-06). Resolves an `unavailable` discriminant, never
 * throws.
 */
export class AppRuntimeTargetAdapter implements AppRuntimeTargetPort {
    private readonly logger = new Logger(AppRuntimeTargetAdapter.name);

    constructor(
        private readonly access: AppRuntimeTargetAccessSource | undefined,
        private readonly states?: {
            getOrCreate(workId: string): Promise<{
                targetSettings?: { networkIsolation?: boolean | null } | null;
            } | null>;
        },
    ) {}

    async prepareDependencyTarget(
        workId: string,
    ): Promise<
        | { ref: AppTargetRef; podLabels: Record<string, string> }
        | { unavailable: AppRuntimeTargetUnavailable }
    > {
        if (!this.access?.resolveClusterAccess) return { unavailable: 'target_none' };

        let answer: Awaited<ReturnType<AppRuntimeTargetAccessSource['resolveClusterAccess']>>;
        try {
            answer = await this.access.resolveClusterAccess(workId);
        } catch (error) {
            this.logger.warn(`Cluster access for work ${workId} failed: ${messageOf(error)}`);
            return { unavailable: 'cluster_unreachable' };
        }

        if (answer.outcome !== 'access') {
            const unavailable = unavailableFor(answer.refusal);
            // The facade's refusal by its own name: several of them (`target_unavailable`, for
            // one — no plugin serves the target) collapse into `cluster_unreachable` here, and
            // without this line the dependency row's reason was the only trace left.
            this.logger.warn(
                `Cluster access for work ${workId} was refused (${String(answer.refusal)}); the dependency target is ${unavailable}.`,
            );
            return { unavailable };
        }

        const { ref, credential, plugin } = answer.access;
        const prepare = (
            plugin as {
                prepareAppNamespace?: (
                    ref: AppTargetRef,
                    credential: string,
                    opts: { isolation: boolean; limitRange: AppLimitRangeInput },
                ) => Promise<unknown>;
            }
        )?.prepareAppNamespace;

        if (typeof prepare === 'function') {
            let isolation = true;
            try {
                const state = await this.states?.getOrCreate(workId);
                isolation = state?.targetSettings?.networkIsolation !== false;
            } catch {
                // The default (isolated) is the safe answer when the row cannot be read.
            }

            try {
                await prepare.call(plugin, ref, credential, {
                    isolation,
                    limitRange: {
                        defaultRequest: { ...DEPENDENCY_NAMESPACE_LIMIT_RANGE.defaultRequest },
                        defaultLimit: { ...DEPENDENCY_NAMESPACE_LIMIT_RANGE.defaultLimit },
                        max: { ...DEPENDENCY_NAMESPACE_LIMIT_RANGE.max },
                    },
                });
            } catch (error) {
                const code = (error as { code?: unknown })?.code;
                this.logger.warn(
                    `prepareAppNamespace for work ${workId} failed (${typeof code === 'string' ? code : 'error'}): ${messageOf(error)}`,
                );
                return {
                    unavailable:
                        code === 'namespace_foreign' || code === 'namespace_owned_elsewhere'
                            ? 'namespace_owned_elsewhere'
                            : 'cluster_unreachable',
                };
            }
        }

        return { ref, podLabels: appDependencyPodLabels(workId) };
    }
}

function unavailableFor(refusal: string): AppRuntimeTargetUnavailable {
    switch (refusal) {
        case 'target_none':
        case 'not_found':
            return 'target_none';
        case 'target_not_checked':
            return 'target_not_checked';
        case 'namespace_owned_elsewhere':
            return 'namespace_owned_elsewhere';
        default:
            return 'cluster_unreachable';
    }
}

/* -------------------------------------------------------------------------- *
 * APP_RUNTIME_NOTIFICATIONS — the two producers (T29)
 * -------------------------------------------------------------------------- */

/** `NotificationService.create`, as far as the producers write it. */
export interface AppRuntimeNotificationWriter {
    create(dto: {
        userId: string;
        type: NotificationType;
        category: NotificationCategory;
        title: string;
        message: string;
        actionUrl?: string;
        actionLabel?: string;
        isPersistent?: boolean;
        deduplicationKey?: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
}

/**
 * §9.4:1335-1336's `notifyAppDeployFailed` (not urgent) and `notifyAppRollbackFailed` (**urgent**,
 * persistent — ACC-06-24), written through `NotificationService.create` (proxied to the API in the
 * worker). Dedupe key `app-deploy:<deploymentId>` and a Deploy-tab link, as T29 states.
 */
export class AppRuntimeNotificationProducersAdapter implements AppRuntimeNotificationProducers {
    constructor(private readonly writer: AppRuntimeNotificationWriter | undefined) {}

    async notifyAppDeployFailed(args: {
        userId: string;
        workId: string;
        deploymentId: string;
        code?: string | null;
    }): Promise<void> {
        if (!this.writer?.create) return;
        await this.writer.create({
            userId: args.userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SYSTEM,
            title: 'App deployment failed',
            message: args.code
                ? `A Deployment of your App failed (${String(args.code).slice(0, 60)}).`
                : 'A Deployment of your App failed.',
            actionUrl: deployTabUrl(args.workId),
            actionLabel: 'Open Deploy',
            deduplicationKey: `app-deploy:${args.deploymentId}`,
            metadata: {
                eventKey: 'app_deploy_failed',
                workId: args.workId,
                deploymentId: args.deploymentId,
            },
        });
    }

    // ── T29's three health producers (§9.4:1337-1339, lane aw-safety 2026-10-26) ─────────────
    //
    // `AppHealthService` (the every-minute `app-health-poll`) calls these through OPTIONAL members
    // that nothing implemented, so an App could be down for hours and its owner was never told.
    // The dedupe keys are §9.4's. The de-dup WINDOW (6 h between down notices) and "recovered only
    // after a down notice of the same streak" are the health service's own rules
    // (`appHealthStreaks`, `lastHealthNotifiedAt`, the shared streak handle) — these only write.

    async notifyAppUnhealthy(args: {
        userId: string;
        workId: string;
        failureStreakStartMs: number;
    }): Promise<void> {
        if (!this.writer?.create || !args?.userId || !args?.workId) return;
        await this.writer.create({
            userId: args.userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SYSTEM,
            title: 'Your App is down',
            message:
                'Your App failed its health checks several times in a row. Open the Deploy tab to ' +
                'see which component is failing.',
            actionUrl: deployTabUrl(args.workId),
            actionLabel: 'Open Deploy',
            isPersistent: true,
            deduplicationKey: `app-unhealthy:${args.workId}:${streakKey(args.failureStreakStartMs)}`,
            metadata: {
                eventKey: 'app_unhealthy',
                urgent: true,
                workId: args.workId,
            },
        });
    }

    async notifyAppRecovered(args: {
        userId: string;
        workId: string;
        failureStreakStartMs: number;
    }): Promise<void> {
        if (!this.writer?.create || !args?.userId || !args?.workId) return;
        await this.writer.create({
            userId: args.userId,
            type: NotificationType.SUCCESS,
            category: NotificationCategory.SYSTEM,
            title: 'Your App is back up',
            message: 'Your App is passing its health checks again.',
            actionUrl: deployTabUrl(args.workId),
            actionLabel: 'Open Deploy',
            deduplicationKey: `app-recovered:${args.workId}:${streakKey(args.failureStreakStartMs)}`,
            metadata: {
                eventKey: 'app_recovered',
                workId: args.workId,
            },
        });
    }

    async notifyAppClusterUnreachable(args: {
        userId: string;
        workId: string;
        unreachableStreakStartMs: number;
    }): Promise<void> {
        if (!this.writer?.create || !args?.userId || !args?.workId) return;
        await this.writer.create({
            userId: args.userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SYSTEM,
            title: 'The cluster your App runs on cannot be reached',
            message:
                'The platform could not reach the cluster your App runs on, so its health is ' +
                'unknown. Check the cluster connection on the Deploy tab.',
            actionUrl: deployTabUrl(args.workId),
            actionLabel: 'Open Deploy',
            isPersistent: true,
            deduplicationKey: `app-cluster-unreachable:${args.workId}:${streakKey(
                args.unreachableStreakStartMs,
            )}`,
            metadata: {
                eventKey: 'app_cluster_unreachable',
                urgent: true,
                workId: args.workId,
            },
        });
    }

    async notifyAppRollbackFailed(args: {
        userId: string;
        workId: string;
        deploymentId: string;
    }): Promise<void> {
        if (!this.writer?.create) return;
        await this.writer.create({
            userId: args.userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SYSTEM,
            title: 'App rollback failed',
            message:
                'A failed Deployment of your App could not be rolled back. Check the Deploy tab now.',
            actionUrl: deployTabUrl(args.workId),
            actionLabel: 'Open Deploy',
            isPersistent: true,
            deduplicationKey: `app-deploy:${args.deploymentId}`,
            metadata: {
                eventKey: 'app_rollback_failed',
                urgent: true,
                workId: args.workId,
                deploymentId: args.deploymentId,
            },
        });
    }
}

function deployTabUrl(workId: string): string {
    return `/works/${encodeURIComponent(String(workId))}/deploy`;
}

/** §9.4's streak handle as a dedupe-key segment — an integer epoch ms, or `0` when unusable. */
function streakKey(ms: number): string {
    return Number.isFinite(ms) && ms > 0 ? String(Math.floor(ms)) : '0';
}

/* -------------------------------------------------------------------------- *
 * APP_COMMIT_ANCESTRY — the upstream-sync verdict's range check (§5.6:841-843)
 * -------------------------------------------------------------------------- */

/**
 * `isAncestorCommit(owner, repo, ancestorSha, commitSha)` over GitHub's public compare API
 * (`GET /repos/{owner}/{repo}/compare/{ancestor}...{commit}`): `ahead`/`identical` ⇒ `true`,
 * `behind`/`diverged` ⇒ `false`, anything else (a private upstream, a rate limit, a network
 * failure) ⇒ `null`, which the orchestrator reads as "unsupported" and falls back to equality.
 * A fork's commits are addressable through the parent repository within one fork network, which
 * is what lets the upstream's coordinates answer for the fork's commit. An optional
 * `GITHUB_TOKEN` in the worker's environment only raises the rate limit.
 */
export class PublicGitHubCommitAncestry implements AppCommitAncestry {
    constructor(
        private readonly fetchImpl?: (
            input: string,
            init?: Record<string, unknown>,
        ) => Promise<{
            ok: boolean;
            json(): Promise<unknown>;
        }>,
        private readonly token: string | undefined = process.env.GITHUB_TOKEN,
    ) {}

    async isAncestorCommit(
        owner: string,
        repo: string,
        ancestorSha: string,
        commitSha: string,
    ): Promise<boolean | null> {
        const safe = (value: string) => /^[A-Za-z0-9_.-]+$/.test(String(value ?? ''));
        const sha = (value: string) => /^[a-f0-9]{7,40}$/i.test(String(value ?? ''));
        if (!safe(owner) || !safe(repo) || !sha(ancestorSha) || !sha(commitSha)) return null;
        if (ancestorSha === commitSha) return true;

        const fetchImpl =
            this.fetchImpl ??
            (
                globalThis as unknown as {
                    fetch: NonNullable<PublicGitHubCommitAncestry['fetchImpl']>;
                }
            ).fetch;

        try {
            const answer = await fetchImpl(
                `https://api.github.com/repos/${owner}/${repo}/compare/${ancestorSha}...${commitSha}`,
                {
                    method: 'GET',
                    headers: {
                        Accept: 'application/vnd.github+json',
                        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
                    },
                },
            );
            if (!answer.ok) return null;
            const body = (await answer.json()) as { status?: unknown } | null;
            if (body?.status === 'ahead' || body?.status === 'identical') return true;
            if (body?.status === 'behind' || body?.status === 'diverged') return false;
            return null;
        } catch {
            return null;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * API side — the event relay (T28) and the dispatch relay (T31 for the worker's dequeue)
 * -------------------------------------------------------------------------- */

/** Keys a relayed payload may never carry (ACC-06-41: names and ids only, never values). */
export const APP_RUNTIME_EVENT_FORBIDDEN_KEYS = [
    'value',
    'values',
    'env',
    'log',
    'logs',
    'kubeconfig',
    'token',
    'password',
    'secret',
    'credential',
] as const;

/** The `app.*` names the worker may relay (§9.4's catalogue, as the worker emits it). */
export const APP_RUNTIME_RELAYED_EVENTS: ReadonlySet<string> = new Set([
    'app.deploy.started',
    'app.deploy.succeeded',
    'app.deploy.failed',
    'app.deploy.rolled_back',
    'app.deploy.paused',
    'app.deploy.resumed',
    'app.deploy.removed',
    'app.job.succeeded',
    'app.job.failed',
    'app.smoke.passed',
    'app.smoke.failed',
    'app.health.changed',
    // Lane aw-safety (2026-10-26) — the three names `AppHealthService.emitTransition` REALLY emits
    // (`APP_HEALTH_EVENT_*`). Only `app.health.changed` was catalogued, so every health transition
    // was refused here and no health Activity row was ever written.
    'app.health.degraded',
    'app.health.recovered',
    'app.health.unreachable',
    'app.dependency.ready',
    'app.dependency.failed',
    'app.dependency.removed',
    // Lane aw-builds-bindings (2026-10-27) — the names `AppDependenciesService.emit` REALLY emits,
    // which are CONTRACTS §6's APW-07 Activity names (`app.dependency.provisioned`, `.failed`,
    // `.released`, `.data_deleted`). Only `.failed` was catalogued, so a worker's "Postgres is
    // ready" and every release or data deletion was refused here, and no dependency lifecycle
    // Activity row was ever written. The three above stay (additive); nothing emits them.
    'app.dependency.provisioned',
    'app.dependency.released',
    'app.dependency.data_deleted',
]);

/**
 * The API end of the worker's `APP_RUNTIME_EVENT_SINK` (`remoteMap.AppRuntimeEventRelayService`):
 * accepts only a catalogued `app.*` name, refuses a payload carrying a forbidden key at any depth
 * (ACC-06-41), and re-emits through `EventEmitter2` so API-side listeners (Activity, the web's
 * live updates) see the worker's events as if they were local.
 */
@Injectable()
export class AppRuntimeEventRelayService implements AppRuntimeEventSink {
    private readonly logger = new Logger(AppRuntimeEventRelayService.name);

    constructor(@Optional() private readonly emitter?: EventEmitter2) {}

    async emit(event: { name: string; payload: Record<string, unknown> }): Promise<void> {
        const name = typeof event?.name === 'string' ? event.name : '';
        if (!APP_RUNTIME_RELAYED_EVENTS.has(name)) {
            throw new Error(
                `Refusing to relay an unknown App runtime event '${name.slice(0, 60)}'.`,
            );
        }
        const payload = (event?.payload ?? {}) as Record<string, unknown>;
        const forbidden = forbiddenKey(payload, 0);
        if (forbidden) {
            throw new Error(
                `Refusing to relay ${name}: its payload carries the forbidden key '${forbidden}'.`,
            );
        }
        if (!this.emitter) {
            this.logger.warn(`No EventEmitter2 is bound, so ${name} was not relayed.`);
            return;
        }
        this.emitter.emit(name, payload);
    }
}

function forbiddenKey(value: unknown, depth: number): string | null {
    if (depth > 4 || value === null || typeof value !== 'object') return null;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if ((APP_RUNTIME_EVENT_FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase()))
            return key;
        const nested = forbiddenKey(entry, depth + 1);
        if (nested) return nested;
    }
    return null;
}

/**
 * The API end of the worker's `APP_DEPLOY_DISPATCHER` (`remoteMap.AppDeployDispatchRelay`): the
 * orchestrator's §5.6 step 7 dequeue dispatches the adopted queued Deployment through the API's
 * own gate (Trigger.dev or the local worker), so the worker never needs a job-runtime binding of
 * its own and the production attestation is checked where it always is.
 */
@Injectable()
export class AppDeployDispatchRelay {
    constructor(
        @Optional()
        @Inject(APP_DEPLOY_DISPATCHER)
        private readonly dispatcher?: AppDeployOrchestratorDispatcher,
    ) {}

    async dispatchAppDeploy(
        payload: Parameters<NonNullable<AppDeployOrchestratorDispatcher['dispatchAppDeploy']>>[0],
        opts?: { delayMs?: number },
    ): Promise<string | null> {
        const gate = this.dispatcher;
        if (!gate) return null;
        if (typeof gate.isEnabled === 'function' && gate.isEnabled() === false) return null;
        const resolved = (typeof gate.resolve === 'function' ? gate.resolve() : gate) as
            | AppDeployOrchestratorDispatcher
            | null
            | undefined;
        if (typeof resolved?.dispatchAppDeploy !== 'function') return null;
        return resolved.dispatchAppDeploy(payload, opts);
    }
}

/**
 * The worker's `APP_DEPLOY_DISPATCHER` view over {@link AppDeployDispatchRelay}'s proxy — the
 * orchestrator reads `isEnabled()` + `resolve().dispatchAppDeploy`.
 */
export function workerAppDeployDispatcher(relay: {
    dispatchAppDeploy: NonNullable<AppDeployOrchestratorDispatcher['dispatchAppDeploy']>;
}): AppDeployOrchestratorDispatcher {
    return {
        isEnabled: () => Boolean(relay),
        resolve: () => ({
            dispatchAppDeploy: (payload, opts) => relay.dispatchAppDeploy(payload, opts),
        }),
    };
}

/**
 * A caught value for a LOG line: name, code, message and cause chain, credential material
 * redacted. A plugin wraps the Kubernetes client's error (`K8sPluginError` → `ApiException` →
 * the socket error), so the message alone hid which of them failed.
 */
function messageOf(error: unknown): string {
    return describeDependencyError(error);
}

/**
 * APW-06 T31 (lane aw-deploy-2) — the API end of the worker's `APP_CLUSTER_OP_DISPATCHER`
 * (`remoteMap.AppClusterOpDispatchRelay`). The worker re-dispatches ops (T58's deletion retries,
 * T26's `ingress-reconcile`, `resume`'s wait) through the API's own gate, exactly as
 * {@link AppDeployDispatchRelay} does for the dequeue, so the worker needs no job-runtime binding.
 */
@Injectable()
export class AppClusterOpDispatchRelay {
    constructor(
        @Optional()
        @Inject(APP_CLUSTER_OP_DISPATCHER)
        private readonly gate?: {
            dispatch(
                payload: { op: string; workId: string; [key: string]: unknown },
                opts?: { delayMs?: number },
            ): Promise<string | null>;
        },
    ) {}

    async dispatch(
        payload: { op: string; workId: string; [key: string]: unknown },
        opts?: { delayMs?: number },
    ): Promise<string | null> {
        if (!this.gate?.dispatch) return null;
        if (!payload || typeof payload.op !== 'string' || typeof payload.workId !== 'string')
            return null;
        return this.gate.dispatch(payload, opts);
    }
}

/* -------------------------------------------------------------------------- *
 * APP_WORK_DELETION_COMPLETION in the worker (APW-06 T58 / §9.8, lane aw-safety 2026-10-26)
 * -------------------------------------------------------------------------- */

/** The ONE member of the API's `AppRuntimeDeletionService` the worker may dial. */
export interface AppRuntimeDeletionFinishRemote {
    finishDeletion(
        workId: string,
        report?: AppWorkDeletionCompletionReport,
    ): Promise<{ completed?: boolean; reason?: string } | null | undefined>;
}

/**
 * The worker's `APP_WORK_DELETION_COMPLETION`: §9.8's "remote proxy of
 * `AppRuntimeDeletionService.finishDeletion(workId, { mayRemain })`" — the method runs in the API,
 * where the guarded completion (`AppWorkDeletionCompletionService`) checks that the row really
 * records a deletion, tells the owner what may remain, and only then asks APW-01 to delete the row.
 *
 * Unbound before 2026-10-26, so a finished removal kept the Work row forever (the fail-closed
 * answer of the deletion service's header table).
 *
 * - **Narrow**: one method over a one-member remote facade, never the raw proxy.
 * - **Fail-closed**: an answer that is not `completed: true` — a refusal, an unbound API side, a
 *   failed hop — THROWS, which the worker's `finishDeletion` reports as `completed: false`; the
 *   Work row is kept and a repeated delete re-dispatches once the claim is stale. Never a
 *   "completed" that did not happen.
 */
export function workerAppWorkDeletionCompletion(
    remote: AppRuntimeDeletionFinishRemote,
): AppWorkDeletionCompletion {
    return {
        async completeAppWorkDeletion(
            workId: string,
            report?: AppWorkDeletionCompletionReport,
        ): Promise<void> {
            const answer = report
                ? await remote.finishDeletion(workId, report)
                : await remote.finishDeletion(workId);
            if (answer?.completed !== true) {
                throw new Error(
                    `The API did not complete the deletion of work ${workId} (${String(
                        answer?.reason ?? 'no_answer',
                    ).slice(0, 60)}).`,
                );
            }
        },
    };
}

/* -------------------------------------------------------------------------- *
 * APPS_TIER_POLICY eligibility in the worker (APW-10 T27 / APW-06 T45, lane aw-safety 2026-10-26)
 * -------------------------------------------------------------------------- */

/** The ONE member of the API's `AppsTierEligibilityService` the worker may dial. */
export interface AppsTierEligibilityRemote {
    evaluate(
        userId: string,
        opts?: { workId?: string | null },
    ): Promise<
        | { eligible?: boolean; reasons?: unknown; counted?: unknown; max?: unknown }
        | null
        | undefined
    >;
}

/**
 * The worker's eligibility source for its `ConfigAppsTierPolicy`: the API's
 * `AppsTierEligibilityService.evaluate` over the internal channel (`remoteMap`), because the facts
 * (the account, the plan, the owner's other App Works) are rows the worker cannot read.
 *
 * Narrow (one method, the answer rebuilt field by field). A malformed answer THROWS, and the
 * worker's policy is built with `onSourceFailure: 'admit'` — the API already ran the authoritative
 * check when the Deployment was requested; the worker's re-check exists to catch a concurrent
 * Deployment, and must not refuse everything during an API/worker rollout skew.
 */
export function workerAppsTierEligibilitySource(remote: AppsTierEligibilityRemote): {
    evaluate(
        userId: string,
        opts?: { workId?: string | null },
    ): Promise<{ eligible: boolean; reasons: string[]; counted?: string[]; max?: number }>;
} {
    return {
        async evaluate(userId: string, opts?: { workId?: string | null }) {
            const workId = typeof opts?.workId === 'string' && opts.workId ? opts.workId : null;
            const answer = await remote.evaluate(String(userId ?? ''), workId ? { workId } : {});
            if (!answer || typeof answer.eligible !== 'boolean') {
                throw new Error('The API answered no eligibility verdict.');
            }
            const out: { eligible: boolean; reasons: string[]; counted?: string[]; max?: number } =
                {
                    eligible: answer.eligible === true,
                    reasons: Array.isArray(answer.reasons)
                        ? answer.reasons.map((reason) => String(reason)).slice(0, 10)
                        : [],
                };
            if (Array.isArray(answer.counted)) {
                out.counted = answer.counted.map((name) => String(name)).slice(0, 20);
            }
            if (typeof answer.max === 'number') {
                out.max = answer.max;
            }
            return out;
        },
    };
}
