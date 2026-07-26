import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import {
    EventIngestService,
    IngestInstallBindingRepository,
    type IngestResult,
} from '@ever-works/agent/ingest';
import { PrReviewService } from '@ever-works/agent/pr-review';
import { PluginSettingsService, UserPluginRepository } from '@ever-works/agent/plugins';
import { TaskReviewRejectionService } from '@ever-works/agent/tasks-domain';
import type { IngestBindingMatch, IngestBindingResolution } from '../install-binding.types';

export const GITHUB_PLUGIN_ID = 'github';

/** Binding-table namespace for GitHub installations / repo owners. */
export const GITHUB_BINDING_PROVIDER = 'github';

/** The mention token that routes a PR comment into the review loop. */
export const EVER_WORKS_MENTION = '@ever-works';

/** Payload text cap for envelopes built from webhook deliveries. */
export const GITHUB_EVENT_TEXT_MAX_CHARS = 4000;

/**
 * The external installation identity a GitHub delivery carries, as an
 * ORDERED list of binding keys (most specific first):
 *
 *   * `installation:<id>` — the GitHub App installation, when present;
 *   * `owner:<login>`     — the repository/organization owner, which is
 *                           what a user-configured repo or org webhook
 *                           carries.
 *
 * Both live in the same `externalWorkspaceId` column under distinct
 * prefixes, so the two namespaces can never collide.
 */
export interface GitHubWorkspaceRef {
    readonly keys: readonly string[];
    /** Human-readable label persisted alongside the binding. */
    readonly label?: string;
}

/**
 * Per-installation binding: the platform user that OWNS the GitHub
 * installation / repository owner a delivery came from, plus the webhook
 * secret the receiver verifies it with.
 *
 * Resolution order and the refusal posture live in
 * `../install-binding.types`. `matchedBy` records which path produced
 * this binding so the receiver knows whether to persist it after
 * signature verification.
 */
export interface GitHubEventsBinding {
    readonly userId: string;
    readonly webhookSecret: string;
    readonly matchedBy: IngestBindingMatch;
    /** The installation/owner this delivery named, when it carried one. */
    readonly workspace?: GitHubWorkspaceRef;
}

/** Inputs the receiver passes when resolving a delivery to its owner. */
export interface GitHubBindingLookup {
    readonly workspace?: GitHubWorkspaceRef;
    /**
     * Verifies the raw delivery against a candidate's webhook secret.
     * Decisive for GitHub, where each install configures its OWN secret:
     * a unique match is cryptographic proof of ownership, not a guess.
     */
    readonly verifySignature?: (webhookSecret: string) => boolean;
}

/** The subset of GitHub webhook payloads the bridge consumes. */
export interface GitHubWebhookBody {
    action?: string;
    installation?: {
        id?: number;
    };
    organization?: {
        login?: string;
    };
    repository?: {
        full_name?: string;
        html_url?: string;
        owner?: { login?: string };
    };
    sender?: {
        login?: string;
        type?: string;
    };
    pull_request?: {
        number?: number;
        title?: string;
        html_url?: string;
        state?: string;
        head?: { sha?: string; ref?: string };
        base?: { ref?: string };
        user?: { login?: string; type?: string };
    };
    issue?: {
        number?: number;
        title?: string;
        html_url?: string;
        pull_request?: { url?: string };
    };
    comment?: {
        id?: number;
        body?: string;
        html_url?: string;
        user?: { login?: string; type?: string };
    };
    /**
     * Orchestration M9 - `pull_request_review` deliveries. A human
     * rejecting the agent's PR is the single most common reason a run
     * gets resumed, and until this shape existed the reviewer's words
     * were lost between the provider and the next run.
     */
    review?: {
        id?: number;
        state?: string;
        body?: string;
        html_url?: string;
        user?: { login?: string; type?: string };
    };
}

/**
 * Read the installation identity off a delivery body.
 *
 * The body is NOT yet signature-verified here, and that is safe: the
 * value only SELECTS which install's webhook secret to verify against, so
 * a forged installation id or owner login picks a secret that fails the
 * HMAC and the delivery is rejected.
 */
export function extractGitHubWorkspaceRef(
    body: GitHubWebhookBody | undefined,
): GitHubWorkspaceRef | undefined {
    const keys: string[] = [];
    const installationId = body?.installation?.id;
    if (typeof installationId === 'number' && Number.isFinite(installationId)) {
        keys.push(`installation:${installationId}`);
    }
    const owner =
        body?.repository?.owner?.login ??
        body?.repository?.full_name?.split('/')[0] ??
        body?.organization?.login;
    if (typeof owner === 'string' && owner.length > 0) {
        keys.push(`owner:${owner.toLowerCase()}`);
    }
    if (keys.length === 0) return undefined;
    return { keys, ...(typeof owner === 'string' && owner ? { label: owner } : {}) };
}

/**
 * GitHub PR review loop (Wave 7, feature g) — ONE service bridging
 * GitHub webhook deliveries into the platform:
 *
 * 1. `resolveBinding()` — the PER-INSTALLATION binding plus the webhook
 *    secret the receiver verifies deliveries with. Deliveries are
 *    attributed to the platform user that owns the installation /
 *    repository owner they came from, never to "the oldest install".
 *    Fail-closed: no configured install → the endpoint 401s; an
 *    unknown/ambiguous installation is refused as a clean no-op.
 * 2. `handleEvent()` — normalizes `pull_request` (opened/synchronize)
 *    and `@ever-works`-mentioning `issue_comment` /
 *    `pull_request_review_comment` deliveries into
 *    `IngestedEventEnvelope`s (`github.pr` / `github.mention`) and
 *    dedupe-inserts them through the event-ingest spine.
 * 3. First-seen events trigger the Work-aware reviewer
 *    (`PrReviewService.reviewPullRequest`) — for mentions, the comment
 *    text rides along as the review instruction and the reply lands
 *    in the PR conversation thread. The review leg is deliberately
 *    not awaited: webhooks need a fast 200, and the review is
 *    best-effort (failures are logged, never thrown).
 *
 * Bot-authored comments (including our own review replies) are never
 * ingested — the loop must not echo its own output.
 */
@Injectable()
export class GitHubPrReviewBridgeService {
    private readonly logger = new Logger(GitHubPrReviewBridgeService.name);

    constructor(
        private readonly userPluginRepository: UserPluginRepository,
        private readonly pluginSettingsService: PluginSettingsService,
        private readonly eventIngestService: EventIngestService,
        private readonly prReviewService: PrReviewService,
        private readonly installBindings: IngestInstallBindingRepository,
        // Orchestration M9 - persist `changes_requested` reviews so the
        // next resumed run reads them. @Optional() is deliberately NOT
        // used: this module already imports TasksDomainModule, and a
        // silently-unbound rejection recorder would be a feature that
        // looks wired and does nothing.
        private readonly rejections: TaskReviewRejectionService,
    ) {}

    /**
     * Resolve one delivery to the platform user that OWNS the GitHub
     * installation / repository owner it came from.
     *
     * Order (see `../install-binding.types`): exact binding → single
     * install (warn, then recorded once verified) → unique signature
     * match → refuse. Never falls back to "some other install": with two
     * repositories configured by two users, each one's events reach
     * exactly its own owner.
     */
    async resolveBinding(
        lookup: GitHubBindingLookup = {},
    ): Promise<IngestBindingResolution<GitHubEventsBinding>> {
        const candidates = await this.loadCandidates();
        if (candidates.length === 0) {
            return { status: 'not-configured' };
        }

        const workspace = lookup.workspace;
        const label = workspace?.keys[0] ?? 'unknown installation';

        // 1. Exact binding — most specific key first (installation id
        //    before repository owner).
        for (const key of workspace?.keys ?? []) {
            const bound = await this.installBindings
                .findByWorkspace(GITHUB_BINDING_PROVIDER, key)
                .catch(() => null);
            if (!bound) continue;
            const owner = candidates.find((c) => c.userId === bound.userId);
            if (owner) {
                return {
                    status: 'resolved',
                    binding: { ...owner, matchedBy: 'binding', workspace },
                };
            }
            // The bound install was removed or lost its webhook secret.
            // Attributing its events to ANOTHER user is exactly the defect
            // this replaces, so refuse instead.
            this.logger.warn(
                `Refusing GitHub delivery for ${key}: the bound install is disabled or unconfigured`,
            );
            return { status: 'unresolved', reason: 'bound-install-unavailable' };
        }

        // 2. Single-install legacy path — nothing to disambiguate.
        if (candidates.length === 1) {
            this.logger.warn(
                `GitHub delivery for ${label} has no installation binding; attributing it to the single configured install (legacy path)`,
            );
            return {
                status: 'resolved',
                binding: {
                    ...candidates[0],
                    matchedBy: 'single-install',
                    ...(workspace ? { workspace } : {}),
                },
            };
        }

        // 3. Signature proof. Each GitHub install configures its OWN
        //    webhook secret, so a unique HMAC match is evidence of
        //    ownership rather than a guess.
        if (lookup.verifySignature) {
            const matches = candidates.filter((c) => lookup.verifySignature!(c.webhookSecret));
            if (matches.length === 1) {
                return {
                    status: 'resolved',
                    binding: {
                        ...matches[0],
                        matchedBy: 'signature',
                        ...(workspace ? { workspace } : {}),
                    },
                };
            }
            if (matches.length > 1) {
                this.logger.warn(
                    `Refusing GitHub delivery for ${label}: ${matches.length} installs share a webhook secret and nothing distinguishes them`,
                );
                return { status: 'unresolved', reason: 'ambiguous-install' };
            }
        }

        this.logger.warn(
            `Refusing GitHub delivery for ${label}: no install is bound to this installation`,
        );
        return { status: 'unresolved', reason: 'unknown-workspace' };
    }

    /**
     * Persist the installation→user binding after a delivery has passed
     * signature verification, so the deployment self-migrates off the
     * legacy single-install path onto exact resolution.
     *
     * Best-effort: a failure here must never break a webhook that has
     * already been verified and handled.
     */
    async recordBinding(binding: GitHubEventsBinding): Promise<void> {
        const key = binding.workspace?.keys[0];
        if (binding.matchedBy === 'binding' || !key) return;
        try {
            await this.installBindings.record({
                provider: GITHUB_BINDING_PROVIDER,
                externalWorkspaceId: key,
                userId: binding.userId,
                pluginId: GITHUB_PLUGIN_ID,
                externalWorkspaceName: binding.workspace?.label ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to record GitHub installation binding for ${key}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Enabled github-plugin installs whose resolved settings carry a
     * webhook secret, oldest first (stable ordering keeps the
     * single-install path deterministic).
     */
    private async loadCandidates(): Promise<Array<{ userId: string; webhookSecret: string }>> {
        const installs = await this.userPluginRepository.findByPlugin(GITHUB_PLUGIN_ID);
        const enabled = installs
            .filter((row) => row.enabled)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        const candidates: Array<{ userId: string; webhookSecret: string }> = [];
        for (const row of enabled) {
            const settings = await this.pluginSettingsService.getSettings(GITHUB_PLUGIN_ID, {
                userId: row.userId,
                includeSecrets: true,
            });
            const webhookSecret = settings?.webhookSecret;
            if (typeof webhookSecret === 'string' && webhookSecret.length > 0) {
                candidates.push({ userId: row.userId, webhookSecret });
            }
        }
        return candidates;
    }

    /**
     * Ingest one verified delivery and (for first-seen events) kick the
     * review loop. Dedupe (`(source, sourceEventId)`) makes webhook
     * retries free: only `inserted > 0` triggers a review, so GitHub
     * redeliveries never double-post.
     */
    async handleEvent(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<{ ingested: IngestResult | null }> {
        // Orchestration M9 - a `pull_request_review` with state
        // `changes_requested` is a HUMAN REJECTION, not a review request.
        // It never enters the review loop (the loop reviews; it does not
        // react to being reviewed), so it is handled and returned before
        // normalize() is consulted.
        if (eventName === 'pull_request_review') {
            await this.recordReviewRejection(binding, body);
            return { ingested: null };
        }

        const normalized = this.normalize(eventName, body);
        if (!normalized) {
            return { ingested: null };
        }

        const ingested = await this.eventIngestService.ingest(binding.userId, [
            normalized.envelope,
        ]);

        if (ingested.inserted > 0) {
            void this.triggerReview(binding, normalized).catch((error: unknown) => {
                // triggerReview handles its own errors; belt-and-suspenders
                // guard so nothing escapes the void.
                this.logger.warn(
                    `PR review trigger failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }

        return { ingested };
    }

    /**
     * Orchestration M9 - persist a `changes_requested` PR review as
     * durable rejection feedback for the Task the PR belongs to.
     *
     * Best-effort throughout: a webhook must answer 200 fast, and every
     * miss here (not a rejection, a bot reviewer, an empty body, a PR
     * that maps to no Work/Task) is an ORDINARY outcome, not an error.
     * Bot reviewers are excluded for the same reason bot comments are:
     * the loop must never treat its own output as human feedback.
     */
    private async recordReviewRejection(
        binding: GitHubEventsBinding,
        body: GitHubWebhookBody,
    ): Promise<void> {
        const review = body.review;
        if (!review || review.state?.toLowerCase() !== 'changes_requested') return;
        if (review.user?.type === 'Bot') return;
        const feedback = (review.body ?? '').trim();
        if (feedback.length === 0) return;

        const fullName = body.repository?.full_name ?? '';
        const [owner, repo] = fullName.split('/');
        const prNumber = body.pull_request?.number;
        if (!owner || !repo || typeof prNumber !== 'number') return;

        try {
            await this.rejections.recordPullRequestRejection({
                userId: binding.userId,
                owner,
                repo,
                prNumber,
                feedback: feedback.slice(0, GITHUB_EVENT_TEXT_MAX_CHARS),
                reviewerLabel: review.user?.login ?? null,
                prUrl: body.pull_request?.html_url ?? review.html_url ?? null,
            });
        } catch (error) {
            this.logger.warn(
                `PR rejection record failed for ${fullName}#${prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** Normalize a delivery into an envelope + review coordinates (or skip it). */
    normalize(
        eventName: string,
        body: GitHubWebhookBody,
    ): {
        envelope: IngestedEventEnvelope;
        owner: string;
        repo: string;
        prNumber: number;
        instruction?: string;
    } | null {
        const fullName = body.repository?.full_name ?? '';
        const [owner, repo] = fullName.split('/');
        if (!owner || !repo) {
            return null;
        }

        if (eventName === 'pull_request') {
            const action = body.action;
            if (action !== 'opened' && action !== 'synchronize') {
                return null;
            }
            const pr = body.pull_request;
            const prNumber = pr?.number;
            if (!pr || typeof prNumber !== 'number') {
                return null;
            }
            // Bot-authored PRs (including platform-created ones) still get
            // reviewed — that is the point of the loop — but bot SENDERS
            // re-syncing metadata are fine too; no sender filter here.
            const headSha = pr.head?.sha ?? action;
            return {
                envelope: {
                    id: randomUUID(),
                    source: GITHUB_PLUGIN_ID,
                    // Identity includes the head SHA so every pushed revision
                    // reviews once — retries and redeliveries dedupe to 0.
                    sourceEventId: `pr:${fullName}#${prNumber}@${headSha}`,
                    kind: 'github.pr',
                    occurredAt: new Date().toISOString(),
                    actor: { name: pr.user?.login ?? body.sender?.login ?? 'unknown' },
                    subject: {
                        type: 'pull_request',
                        externalId: `${fullName}#${prNumber}`,
                        ...(pr.title ? { title: pr.title } : {}),
                    },
                    // Work routing: the repository is the container. The
                    // spine resolves `owner/repo` against the ingesting
                    // user's own Works via the shared repo matcher.
                    workHint: { kind: 'repo', externalId: fullName },
                    ...(pr.html_url ? { sourceUrl: pr.html_url } : {}),
                    payload: {
                        action,
                        repoFullName: fullName,
                        prNumber,
                        ...(pr.head?.sha ? { headSha: pr.head.sha } : {}),
                        ...(pr.head?.ref ? { headRef: pr.head.ref } : {}),
                        ...(pr.base?.ref ? { baseRef: pr.base.ref } : {}),
                        ...(pr.title ? { title: pr.title.slice(0, 500) } : {}),
                    },
                },
                owner,
                repo,
                prNumber,
            };
        }

        if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
            if (body.action !== 'created') {
                return null;
            }
            const comment = body.comment;
            const text = comment?.body ?? '';
            if (!comment || typeof comment.id !== 'number') {
                return null;
            }
            // Never ingest bot-authored comments (incl. our own review
            // replies) — the loop must not echo its own output.
            if (comment.user?.type === 'Bot') {
                return null;
            }
            if (!text.toLowerCase().includes(EVER_WORKS_MENTION)) {
                return null;
            }
            // issue_comment fires for plain issues too — only PR threads
            // route into the review loop.
            const prNumber =
                eventName === 'issue_comment'
                    ? body.issue?.pull_request
                        ? body.issue?.number
                        : undefined
                    : body.pull_request?.number;
            if (typeof prNumber !== 'number') {
                return null;
            }
            const instruction = this.stripMention(text).slice(0, GITHUB_EVENT_TEXT_MAX_CHARS);
            const title = body.issue?.title ?? body.pull_request?.title;
            return {
                envelope: {
                    id: randomUUID(),
                    source: GITHUB_PLUGIN_ID,
                    sourceEventId: `comment:${fullName}:${comment.id}`,
                    kind: 'github.mention',
                    occurredAt: new Date().toISOString(),
                    actor: { name: comment.user?.login ?? 'unknown' },
                    subject: {
                        type: 'pull_request',
                        externalId: `${fullName}#${prNumber}`,
                        ...(title ? { title } : {}),
                    },
                    workHint: { kind: 'repo', externalId: fullName },
                    ...(comment.html_url ? { sourceUrl: comment.html_url } : {}),
                    payload: {
                        repoFullName: fullName,
                        prNumber,
                        commentId: comment.id,
                        text: text.slice(0, GITHUB_EVENT_TEXT_MAX_CHARS),
                    },
                },
                owner,
                repo,
                prNumber,
                instruction,
            };
        }

        return null;
    }

    /**
     * Run the Work-aware reviewer for one normalized event.
     * BEST-EFFORT end to end: every failure is logged and swallowed —
     * the webhook already 200'd and GitHub retries would only
     * duplicate work.
     */
    private async triggerReview(
        binding: GitHubEventsBinding,
        input: { owner: string; repo: string; prNumber: number; instruction?: string },
    ): Promise<void> {
        try {
            const result = await this.prReviewService.reviewPullRequest({
                userId: binding.userId,
                owner: input.owner,
                repo: input.repo,
                prNumber: input.prNumber,
                ...(input.instruction ? { instruction: input.instruction } : {}),
            });
            if (result.status === 'posted') {
                this.logger.log(
                    `PR review posted for ${input.owner}/${input.repo}#${input.prNumber} (comment ${result.commentId})`,
                );
            } else {
                this.logger.warn(
                    `PR review did not post for ${input.owner}/${input.repo}#${input.prNumber}: ${result.error ?? 'unknown'}`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `PR review failed for ${input.owner}/${input.repo}#${input.prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** Strip `@ever-works` mention tokens (and stray whitespace) from the text. */
    private stripMention(text: string): string {
        return text.replace(new RegExp(EVER_WORKS_MENTION, 'gi'), ' ').replace(/\s+/g, ' ').trim();
    }
}
