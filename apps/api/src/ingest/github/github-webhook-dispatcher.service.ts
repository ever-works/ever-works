import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
    GitHubAppInstallationRepository,
    GitHubAppUserLinkRepository,
} from '@ever-works/agent/database';
import { config } from '../../config/constants';
import { GitHubAppSyncService } from '../../integrations/github-app/github-app-sync.service';
import type { IngestBindingRefusal } from '../install-binding.types';
import {
    GITHUB_BINDING_PROVIDER,
    GITHUB_PLUGIN_ID,
    GitHubPrReviewBridgeService,
    extractGitHubWorkspaceRef,
    type GitHubEventsBinding,
    type GitHubWebhookBody,
    type GitHubWorkspaceRef,
} from './github-pr-review-bridge.service';
import { verifyGitHubSignature } from './github-signature.util';

/** One inbound GitHub delivery, as both receivers hand it over. */
export interface GitHubWebhookDelivery {
    readonly rawBody: string | undefined;
    readonly signature: string | undefined;
    readonly eventName: string | undefined;
    readonly body: unknown;
}

/** Which credential proved the delivery authentic. */
export type GitHubWebhookCredential = 'app-secret' | 'install-secret';

/**
 * The `x-github-event` names on which `GitHubAppSyncService` WRITES
 * platform state: `installation` upserts / soft-deletes a row in
 * `github_app_installations` and can overwrite its
 * `createdByGithubUserId`; `installation_repositories` re-pulls the
 * installation's private repository list; `push` stamps
 * `pendingSyncRequestedAt` on whichever Work claims the named repo.
 *
 * Each of those acts on an identifier taken STRAIGHT OUT of the body
 * (`installation.id`, `repository.full_name`) with no relation to the
 * verified sender, so they may only run when GitHub itself vouched for
 * the delivery with the PLATFORM App webhook secret. A delivery verified
 * with a tenant's own per-install `webhookSecret` proves who the sender
 * is, and a tenant is not an authority on another tenant's App
 * installation — before this gate, any tenant could sign
 * `{"action":"deleted","installation":{"id":<victim>}}` with their own
 * secret and soft-delete a stranger's installation.
 *
 * Every OTHER event name is left flowing to the sync service exactly as
 * before: `handleWebhook` has no branch for them, so the call is an inert
 * no-op and the consolidated fan-out keeps its shape.
 */
const APP_STATE_EVENTS: readonly string[] = ['installation', 'installation_repositories', 'push'];

/**
 * The ONE 401 body this receiver ever returns.
 *
 * A receiver that answers 'not configured' when a secret is missing and
 * 'invalid signature' when it is present hands an unauthenticated prober
 * a configuration oracle. Both cases mean the same thing to a caller —
 * nothing here verified you — so both say it the same way.
 */
export const INVALID_GITHUB_SIGNATURE = 'Invalid GitHub webhook signature';

/**
 * Outcome of one dispatch. Both consumers' failures are REPORTED rather
 * than thrown, so each route can keep its own historical failure
 * contract (see the class doc).
 */
export interface GitHubWebhookDispatchResult {
    readonly ok: true;
    /** Set when the delivery could not be attributed (clean 200 no-op). */
    readonly ignored?: IngestBindingRefusal;
    /** Which secret verified the delivery (absent only when `ignored`). */
    readonly credential?: GitHubWebhookCredential;
    /** Consumers that actually ran. */
    readonly handled: {
        readonly sync: boolean;
        readonly review: boolean;
    };
    /** Per-consumer failures, isolated so one leg cannot sink the other. */
    readonly errors: {
        readonly sync?: unknown;
        readonly review?: unknown;
        /**
         * First failure among the REGISTERED intake consumers (issues,
         * Dependabot alerts — see {@link GitHubWebhookConsumer}). The
         * canonical route rethrows it like `review`; the legacy App route
         * only logs it.
         */
        readonly intake?: unknown;
    };
}

/**
 * A downstream consumer of VERIFIED, owner-attributed GitHub deliveries
 * that is not the PR-review bridge — the issue / Dependabot intake.
 *
 * Registered at boot (`registerConsumer`) by the feature service that
 * owns it, the same way kind processors register on the ingest spine:
 * the dispatcher stays dependency-free of the intakes it feeds, its
 * constructor arity (pinned by `ingest.module.spec.ts`) is untouched,
 * and the PR-review bridge — owned by a sibling change — is never
 * edited to learn about new event names.
 *
 * Consumers see a delivery only after the signature verified and the
 * binding resolved; they are skipped for `ping` and for unattributable
 * App deliveries, exactly like the review leg.
 */
export interface GitHubWebhookConsumer {
    /** `x-github-event` names this consumer handles (e.g. `issues`). */
    readonly events: readonly string[];
    handle(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<unknown>;
}

/**
 * ONE GitHub webhook receiver (audit 08(g) consolidation).
 *
 * The platform used to run TWO independent GitHub receivers:
 *
 *  1. `POST /api/github-app/webhooks` — the platform GitHub App webhook.
 *     Verified against the app-level `GITHUB_APP_WEBHOOK_SECRET`, fanned
 *     out to `GitHubAppSyncService` (installation / repository sync)
 *     ONLY. It had no idea the review loop existed.
 *  2. `POST /api/ingest/github/events` — the Wave 7 PR-review receiver.
 *     Verified against the PER-USER `github` plugin install's
 *     `webhookSecret`, fanned out to `GitHubPrReviewBridgeService`
 *     (ingest envelopes + AI PR review) ONLY.
 *
 * Consequence: installing the GitHub App did NOT turn reviews on. The
 * user had to go and configure a SECOND webhook, with a second secret,
 * pointing at the other URL.
 *
 * This service is the merge. Both routes now call `dispatch()`, which:
 *
 *  * **verifies the signature once**, in one place, with one helper
 *    (`verifyGitHubSignature`), accepting either configured credential —
 *    the platform app secret or the delivery's own install secret. Two
 *    secrets exist because GitHub signs with whichever secret is
 *    configured on the webhook that fired; a single receiver must accept
 *    both or it would regress one of the two surfaces;
 *  * **resolves ONE install binding** out of `ingest_install_bindings`,
 *    extended with an `app-install` path so an App installation resolves
 *    to the platform user who installed it (`createdByUserId`, or the
 *    GitHub user link behind `createdByGithubUserId`) and is then
 *    RECORDED into the same table — no second binding store;
 *  * **fans out internally to every consumer**: the App sync service and
 *    the PR-review/ingest bridge, on every verified delivery, regardless
 *    of which URL it arrived at — except that the sync leg's
 *    STATE-WRITING events ({@link APP_STATE_EVENTS}) require the platform
 *    App credential, because a tenant's own webhook secret is not an
 *    authority on another tenant's App installation.
 *
 * ## Failure contracts are per-route, on purpose
 *
 * Fanning out to a second consumer must not invent a new way for an
 * existing route to fail. So `dispatch()` never throws for a CONSUMER
 * failure — it returns both legs' errors and each controller rethrows
 * only the leg it has always been able to fail on:
 *
 *  * the legacy `/api/github-app/webhooks` route rethrows a SYNC-leg
 *    failure (it always 500'd on those, and GitHub's retry is
 *    load-bearing for installation sync) and logs a review-leg failure;
 *  * the canonical `/api/ingest/github/events` route rethrows a
 *    REVIEW-leg failure (its historical behaviour) and logs a sync-leg
 *    failure.
 *
 * Authentication failures — `not-configured` (401), bad signature (401),
 * unattributable installation (200 no-op) — are unchanged and shared.
 */
@Injectable()
export class GitHubWebhookDispatcherService {
    private readonly logger = new Logger(GitHubWebhookDispatcherService.name);

    /** Intake consumers registered at boot — see {@link GitHubWebhookConsumer}. */
    private readonly consumers: GitHubWebhookConsumer[] = [];

    constructor(
        private readonly bridge: GitHubPrReviewBridgeService,
        private readonly appSync: GitHubAppSyncService,
        private readonly installations: GitHubAppInstallationRepository,
        private readonly userLinks: GitHubAppUserLinkRepository,
    ) {}

    /**
     * Register an intake consumer for specific `x-github-event` names.
     * Feature services call this from `onModuleInit` (the dispatcher is a
     * process singleton, so both receiver routes see it).
     */
    registerConsumer(consumer: GitHubWebhookConsumer): void {
        this.consumers.push(consumer);
    }

    /**
     * Verify one delivery and fan it out to every consumer.
     *
     * Throws only for authentication problems (400 malformed, 401
     * unverifiable) — consumer failures come back in `errors`.
     */
    async dispatch(delivery: GitHubWebhookDelivery): Promise<GitHubWebhookDispatchResult> {
        const { eventName } = delivery;
        if (!eventName) {
            throw new BadRequestException('Missing GitHub event header');
        }
        if (!delivery.rawBody) {
            throw new BadRequestException('Missing raw request payload');
        }

        const rawBody = delivery.rawBody;
        const signature = delivery.signature;
        const body = (delivery.body ?? {}) as GitHubWebhookBody;
        const workspace = extractGitHubWorkspaceRef(body);

        const verify = (webhookSecret: string | undefined) =>
            verifyGitHubSignature({ rawBody, signature, webhookSecret }).valid;

        // ---- One signature verification, two accepted credentials ----
        //
        // The platform App secret first: it is a single configured value,
        // so the check is free and needs no database round-trip. When it
        // is unset (self-hosted deployments without a GitHub App) this is
        // always false and the flow is byte-for-byte the pre-existing
        // per-install path.
        const appSecret = config.githubApp.webhookSecret();
        let credential: GitHubWebhookCredential;
        let binding: GitHubEventsBinding | null;

        if (verify(appSecret)) {
            credential = 'app-secret';
            binding = await this.resolveAppInstallOwner(workspace, appSecret as string);
            if (binding) {
                await this.bridge.recordBinding(binding);
            }
        } else {
            credential = 'install-secret';
            // Resolve WHICH install owns this delivery before verifying,
            // so the right secret is used. The workspace ref comes from
            // the unverified body and only SELECTS a candidate secret — a
            // forged id picks a secret that fails the HMAC below.
            const resolution = await this.bridge.resolveBinding({
                workspace,
                verifySignature: (webhookSecret) => verify(webhookSecret),
            });

            // Fail-closed: nothing configured anywhere → reject, including
            // the initial `ping` (GitHub signs that too).
            //
            // The message is deliberately the SAME one a bad signature
            // gets. "Not configured" here means `loadCandidates()` came
            // back empty — i.e. no user anywhere on this deployment has an
            // enabled `github` install with a webhook secret. Saying so to
            // an unauthenticated prober is a per-deployment tenant oracle:
            // it tells them which integrations are live before they hold
            // any credential. Operators read the reason out of the logs,
            // which is where it belongs.
            if (resolution.status === 'not-configured') {
                throw new UnauthorizedException(INVALID_GITHUB_SIGNATURE);
            }
            // Unknown/ambiguous installation → clean no-op. The bridge
            // already logged the refusal; 200 so GitHub does not retry a
            // delivery we will never be able to attribute.
            if (resolution.status === 'unresolved') {
                return {
                    ok: true,
                    ignored: resolution.reason,
                    handled: { sync: false, review: false },
                    errors: {},
                };
            }

            binding = resolution.binding;
            if (!verify(binding.webhookSecret)) {
                throw new UnauthorizedException(INVALID_GITHUB_SIGNATURE);
            }

            // Verified — persist the installation→user binding so
            // subsequent deliveries resolve exactly instead of through
            // the fallback.
            await this.bridge.recordBinding(binding);
        }

        // ---- Fan out to every consumer -------------------------------
        const errors: { sync?: unknown; review?: unknown; intake?: unknown } = {};

        // 1. GitHub App sync (installation / installation_repositories).
        //    Ran on every verified delivery of the legacy route before;
        //    now runs on every verified delivery of BOTH routes — EXCEPT
        //    the state-writing event names, which require the platform App
        //    credential (see {@link APP_STATE_EVENTS}).
        let syncHandled = false;
        if (credential !== 'app-secret' && APP_STATE_EVENTS.includes(eventName)) {
            this.logger.warn(
                `Refusing to run the GitHub App sync leg for '${eventName}': the delivery verified with a per-install secret, which is not an authority on platform App state`,
            );
        } else {
            try {
                await this.appSync.handleWebhook(eventName, body as never);
                syncHandled = true;
            } catch (error) {
                errors.sync = error;
                this.logger.warn(
                    `GitHub App sync failed for '${eventName}': ${this.messageOf(error)}`,
                );
            }
        }

        // 2. Ingest spine + PR review. `ping` is the webhook-creation
        //    handshake — acknowledged, never dispatched.
        let reviewHandled = false;
        if (eventName !== 'ping' && binding) {
            try {
                await this.bridge.handleEvent(binding, eventName, body);
                reviewHandled = true;
            } catch (error) {
                errors.review = error;
                this.logger.warn(
                    `GitHub ingest/review bridge failed for '${eventName}': ${this.messageOf(error)}`,
                );
            }
        } else if (eventName !== 'ping' && !binding) {
            // App-secret delivery we cannot attribute to a platform user.
            // The sync leg still ran (it is user-agnostic); the review and
            // INTAKE legs have no owner to run as, so they are skipped
            // rather than guessed — an unattributable `issues` delivery
            // files nothing rather than filing into somebody's org. The
            // owner-less case is named explicitly here because it is the
            // one way a correctly signed issue produces no Task at all.
            this.logger.warn(
                `GitHub delivery '${eventName}' verified with the app secret but no platform owner is bound to ${
                    workspace?.keys[0] ?? 'the installation'
                }; skipping the review and intake legs`,
            );
        }

        // 3. Registered intake consumers (issues, Dependabot alerts, …).
        //    Same verified delivery, same owner binding as the review
        //    leg; a failure is isolated into `errors.intake` so neither
        //    route grows a new way to fail on the legs it already had.
        if (eventName !== 'ping' && binding) {
            for (const consumer of this.consumers) {
                if (!consumer.events.includes(eventName)) continue;
                try {
                    await consumer.handle(binding, eventName, body);
                } catch (error) {
                    errors.intake ??= error;
                    this.logger.warn(
                        `GitHub intake consumer failed for '${eventName}': ${this.messageOf(error)}`,
                    );
                }
            }
        }

        return {
            ok: true,
            credential,
            handled: { sync: syncHandled, review: reviewHandled },
            errors,
        };
    }

    /**
     * Owner for a delivery that verified against the PLATFORM App secret.
     *
     * Order — AUTHORITATIVE PLATFORM STATE FIRST:
     *
     *   1. `github_app_installations.createdByUserId` — the platform user
     *      who installed the App, written by the App-install flow;
     *   2. that installation's `createdByGithubUserId` resolved through
     *      `github_app_user_links`;
     *   3. only then an existing `ingest_install_bindings` row for the
     *      delivery's installation / owner key — the same single binding
     *      table the per-install path uses.
     *
     * The order matters and used to be the other way round. Binding rows
     * on the `install-secret` path are written from an UNVERIFIED body
     * (`recordBinding`), so a tenant can name `owner:<somebody-else>` in
     * a body signed with their own webhook secret. With the binding
     * consulted first, that squatted row outranked
     * `github_app_installations` and every genuinely App-signed delivery
     * for the victim's installation — their issues included — was filed
     * into the squatter's organization. Platform state cannot be written
     * by an inbound delivery that only proved the sender's own secret, so
     * it goes first and the binding row is the fallback for
     * installations the App-install flow never recorded.
     *
     * `null` when none of the three answer: the review leg is skipped
     * rather than attributed to an arbitrary user.
     */
    private async resolveAppInstallOwner(
        workspace: GitHubWorkspaceRef | undefined,
        appSecret: string,
    ): Promise<GitHubEventsBinding | null> {
        const asBinding = (userId: string): GitHubEventsBinding => ({
            userId,
            webhookSecret: appSecret,
            matchedBy: 'app-install',
            ...(workspace ? { workspace } : {}),
        });

        const installationKey = workspace?.keys.find((key) => key.startsWith('installation:'));
        if (installationKey) {
            const installationId = installationKey.slice('installation:'.length);
            const installation = await this.installations
                .findByInstallationId(installationId)
                .catch((error: unknown) => {
                    this.logger.warn(
                        `GitHub App installation lookup failed for ${installationId}: ${this.messageOf(error)}`,
                    );
                    return null;
                });

            if (installation?.createdByUserId) {
                return asBinding(installation.createdByUserId);
            }

            if (installation?.createdByGithubUserId) {
                const link = await this.userLinks
                    .findByGithubUserId(installation.createdByGithubUserId)
                    .catch(() => null);
                if (link?.userId) {
                    return asBinding(link.userId);
                }
            }
        }

        for (const key of workspace?.keys ?? []) {
            const bound = await this.bridge.installBindingFor(key);
            if (bound) {
                return { ...asBinding(bound.userId), matchedBy: 'binding' };
            }
        }

        return null;
    }

    private messageOf(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

/** Re-exported so the receivers can name the binding namespace/plugin. */
export { GITHUB_BINDING_PROVIDER, GITHUB_PLUGIN_ID };
