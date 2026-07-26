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
    };
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
 *    of which URL it arrived at.
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

    constructor(
        private readonly bridge: GitHubPrReviewBridgeService,
        private readonly appSync: GitHubAppSyncService,
        private readonly installations: GitHubAppInstallationRepository,
        private readonly userLinks: GitHubAppUserLinkRepository,
    ) {}

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
            if (resolution.status === 'not-configured') {
                throw new UnauthorizedException('GitHub events receiver is not configured');
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
                throw new UnauthorizedException('Invalid GitHub webhook signature');
            }

            // Verified — persist the installation→user binding so
            // subsequent deliveries resolve exactly instead of through
            // the fallback.
            await this.bridge.recordBinding(binding);
        }

        // ---- Fan out to every consumer -------------------------------
        const errors: { sync?: unknown; review?: unknown } = {};

        // 1. GitHub App sync (installation / installation_repositories).
        //    Ran on every verified delivery of the legacy route before;
        //    now runs on every verified delivery of BOTH routes.
        let syncHandled = false;
        try {
            await this.appSync.handleWebhook(eventName, body as never);
            syncHandled = true;
        } catch (error) {
            errors.sync = error;
            this.logger.warn(`GitHub App sync failed for '${eventName}': ${this.messageOf(error)}`);
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
            // The sync leg still ran (it is user-agnostic); the review leg
            // has no owner to run as, so it is skipped rather than guessed.
            this.logger.warn(
                `GitHub delivery '${eventName}' verified with the app secret but no platform owner is bound to ${
                    workspace?.keys[0] ?? 'the installation'
                }; skipping the review leg`,
            );
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
     * Order (mirrors the per-install resolver's "never guess" posture):
     *
     *   1. an existing `ingest_install_bindings` row for the delivery's
     *      installation / owner key — the same single binding table the
     *      per-install path uses;
     *   2. `github_app_installations.createdByUserId` — the platform user
     *      who installed the App;
     *   3. that installation's `createdByGithubUserId` resolved through
     *      `github_app_user_links`.
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

        for (const key of workspace?.keys ?? []) {
            const bound = await this.bridge.installBindingFor(key);
            if (bound) {
                return { ...asBinding(bound.userId), matchedBy: 'binding' };
            }
        }

        const installationKey = workspace?.keys.find((key) => key.startsWith('installation:'));
        if (!installationKey) {
            return null;
        }
        const installationId = installationKey.slice('installation:'.length);

        const installation = await this.installations
            .findByInstallationId(installationId)
            .catch((error: unknown) => {
                this.logger.warn(
                    `GitHub App installation lookup failed for ${installationId}: ${this.messageOf(error)}`,
                );
                return null;
            });
        if (!installation) {
            return null;
        }

        if (installation.createdByUserId) {
            return asBinding(installation.createdByUserId);
        }

        if (installation.createdByGithubUserId) {
            const link = await this.userLinks
                .findByGithubUserId(installation.createdByGithubUserId)
                .catch(() => null);
            if (link?.userId) {
                return asBinding(link.userId);
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
