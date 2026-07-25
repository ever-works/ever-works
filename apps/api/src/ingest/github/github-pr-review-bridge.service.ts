import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { EventIngestService, type IngestResult } from '@ever-works/agent/ingest';
import { PrReviewService } from '@ever-works/agent/pr-review';
import { PluginSettingsService, UserPluginRepository } from '@ever-works/agent/plugins';

export const GITHUB_PLUGIN_ID = 'github';

/** The mention token that routes a PR comment into the review loop. */
export const EVER_WORKS_MENTION = '@ever-works';

/** Payload text cap for envelopes built from webhook deliveries. */
export const GITHUB_EVENT_TEXT_MAX_CHARS = 4000;

/**
 * v1 install→user binding (same posture as `SlackEventsBinding`): the
 * events land under the platform user who configured the github
 * plugin's `webhookSecret` (oldest enabled install wins). Per-repo /
 * per-installation user mapping is a documented follow-up.
 */
export interface GitHubEventsBinding {
    readonly userId: string;
    readonly webhookSecret: string;
}

/** The subset of GitHub webhook payloads the bridge consumes. */
export interface GitHubWebhookBody {
    action?: string;
    repository?: {
        full_name?: string;
        html_url?: string;
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
}

/**
 * GitHub PR review loop (Wave 7, feature g) — ONE service bridging
 * GitHub webhook deliveries into the platform:
 *
 * 1. `resolveBinding()` — the v1 install→user binding plus the webhook
 *    secret the receiver verifies deliveries with. Fail-closed: no
 *    configured install → no binding → the endpoint 401s.
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
    ) {}

    /**
     * Resolve the v1 events binding: the OLDEST enabled github-plugin
     * install whose resolved settings carry a webhook secret. Returns
     * null when nothing is configured — callers must fail closed.
     */
    async resolveBinding(): Promise<GitHubEventsBinding | null> {
        const installs = await this.userPluginRepository.findByPlugin(GITHUB_PLUGIN_ID);
        const candidates = installs
            .filter((row) => row.enabled)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        for (const row of candidates) {
            const settings = await this.pluginSettingsService.getSettings(GITHUB_PLUGIN_ID, {
                userId: row.userId,
                includeSecrets: true,
            });
            const webhookSecret = settings?.webhookSecret;
            if (typeof webhookSecret === 'string' && webhookSecret.length > 0) {
                return { userId: row.userId, webhookSecret };
            }
        }
        return null;
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
