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
import { TaskGitLinkService, TaskReviewRejectionService } from '@ever-works/agent/tasks-domain';
import type { TaskGitLink } from '@ever-works/agent/tasks-domain';
import type { IngestBindingMatch, IngestBindingResolution } from '../install-binding.types';
import { config } from '../../config/constants';
import {
    classifyReviewer,
    formatInlineFinding,
    isReviewBotNoise,
    parseReviewBotSeverity,
    stripReviewBotMarkup,
    type ReviewBotPolicy,
} from './github-review-bots';

export const GITHUB_PLUGIN_ID = 'github';

/** Binding-table namespace for GitHub installations / repo owners. */
export const GITHUB_BINDING_PROVIDER = 'github';

/** The mention token that routes a PR comment into the review loop. */
export const EVER_WORKS_MENTION = '@ever-works';

/** Payload text cap for envelopes built from webhook deliveries. */
export const GITHUB_EVENT_TEXT_MAX_CHARS = 4000;

/**
 * Per-push cap on the `github.commit` envelopes one delivery produces.
 *
 * GitHub itself truncates `commits[]` at 20 entries (`head_commit` plus
 * the `size`/`distinct_size` counters carry the true totals), so this is
 * the provider's own ceiling restated locally rather than a policy of
 * ours — a monster push cannot turn into an unbounded Activity burst.
 */
export const GITHUB_PUSH_COMMITS_MAX = 20;

/**
 * `ingested_events.sourceEventId` is `varchar(200)`.
 *
 * Only the git-activity ids need the guard: a branch name may be 255
 * characters on its own, so `push:<repo>@<sha>:<branch>` is the one id
 * shape that can realistically overflow the column. The SHA sits BEFORE
 * the branch on purpose — truncation then trims the branch tail and
 * keeps the part that actually makes the id unique.
 */
export const GITHUB_SOURCE_EVENT_ID_MAX_CHARS = 200;

/**
 * `ingested_events.subjectExternalId` is `varchar(200)` too, and a push
 * subject is `<owner/repo>@<branch>` — the same 255-character branch name
 * can overflow it. An oversized value would abort the INSERT and lose
 * the whole delivery, so the subject is capped at the column width.
 */
export const GITHUB_SUBJECT_EXTERNAL_ID_MAX_CHARS = 200;

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

/**
 * One commit as a `push` delivery reports it (git activity ingestion,
 * audit item j). `distinct` is false for commits that already reached the
 * repository on another ref — those are re-announcements, not new work.
 */
export interface GitHubPushCommit {
    id?: string;
    message?: string;
    url?: string;
    distinct?: boolean;
    timestamp?: string;
    author?: { name?: string; username?: string; email?: string };
    added?: string[];
    removed?: string[];
    modified?: string[];
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
        /**
         * Git activity ingestion (audit item j) — `closed` fires for both
         * "merged" and "abandoned", and only `merged` tells them apart.
         */
        merged?: boolean;
        merged_at?: string | null;
        merge_commit_sha?: string | null;
        merged_by?: { login?: string; type?: string } | null;
    };
    /**
     * Git activity ingestion (audit item j) — `push` deliveries. `ref` is
     * the FULL ref (`refs/heads/<branch>`); `commits[]` is capped by
     * GitHub at 20 entries while `head_commit` always carries the tip.
     */
    ref?: string;
    before?: string;
    after?: string;
    created?: boolean;
    deleted?: boolean;
    forced?: boolean;
    compare?: string;
    pusher?: { name?: string; email?: string };
    commits?: GitHubPushCommit[];
    head_commit?: GitHubPushCommit | null;
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
        /**
         * Trusted review bots (R16) — `pull_request_review_comment` only.
         * The diff anchor of an inline finding: `line` on the current
         * diff, `original_line` when the line has since moved. Recorded
         * as `path:line` in front of the finding so the resumed run can
         * open the file the reviewer bot meant.
         */
        path?: string;
        line?: number | null;
        original_line?: number | null;
        pull_request_review_id?: number;
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
 * True for the deliveries git-activity ingestion owns (audit item j).
 *
 * `push` is unconditional. A pull request only qualifies on
 * `closed` + `merged: true` — GitHub fires the same `closed` action for
 * an abandoned PR, and an abandoned PR merged nothing.
 */
export function isGitActivityDelivery(
    eventName: string,
    body: GitHubWebhookBody | undefined,
): boolean {
    if (eventName === 'push') return true;
    return (
        eventName === 'pull_request' &&
        body?.action === 'closed' &&
        body?.pull_request?.merged === true
    );
}

/** First line of a commit message — the subject, in git's own vocabulary. */
function commitSubject(message: string | undefined): string {
    return (message ?? '').split('\n')[0]?.trim() ?? '';
}

/** Keep a value inside its `ingested_events` column width. */
function capped(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
}

/** Keep a git-activity id inside `ingested_events.sourceEventId`. */
function cappedEventId(value: string): string {
    return capped(value, GITHUB_SOURCE_EVENT_ID_MAX_CHARS);
}

/**
 * A source-reported timestamp when it parses, otherwise now.
 *
 * The spine REJECTS an envelope whose `occurredAt` will not parse, so a
 * malformed provider timestamp must never reach it — losing the true
 * commit time is a much smaller loss than losing the event.
 */
function isoOrNow(value: string | null | undefined): string {
    if (typeof value === 'string' && value.length > 0) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return new Date().toISOString();
}

/** The `taskId`/`taskSlug` payload block, or nothing when unlinked. */
function taskFields(link: TaskGitLink | null): Record<string, unknown> {
    if (!link) return {};
    return {
        taskId: link.taskId,
        ...(link.taskSlug ? { taskSlug: link.taskSlug } : {}),
    };
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
 * ## Reviewer bots (self-build fleet, finding R16)
 *
 * The platform's OWN replies (`<GITHUB_APP_SLUG>[bot]`) and any bot that
 * is not on the trusted allow-list are never ingested — the loop must not
 * echo its own output, and an unknown automation must not steer a Task.
 * Reviews, inline findings and summary comments from the TRUSTED reviewer
 * bots (`config.githubReviewBots`; CodeRabbit, Copilot, Codex and Greptile
 * by default) become Task rejection feedback carrying the bot's own
 * severity, so the next resumed run fixes P2+ first. They are recorded,
 * never reviewed: a bot comment does not enter the mention loop even when
 * it happens to say `@ever-works`.
 *
 * ## Git activity (audit item j)
 *
 * `push` and merged `pull_request` deliveries were previously dropped on
 * the floor, so commits, pushes and merges never reached the Activity
 * feed at all. They now normalize into `github.push` / `github.commit` /
 * `github.merge` envelopes on the SAME path (dedupe-insert → spine drain
 * → Activity row), and the spine gives those three kinds their own
 * `ActivityActionType` instead of the generic ingested-event one. They
 * are deliberately kept OUT of the review loop: the code has already
 * landed, so there is nothing left to review.
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
        // Git activity ingestion (audit item j) - branch/PR -> Task
        // resolution for push / commit / merge envelopes. Appended LAST
        // and, like `rejections`, deliberately NOT @Optional(): the same
        // TasksDomainModule provides it.
        private readonly taskLinks: TaskGitLinkService,
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
     * The platform user bound to one GitHub workspace key
     * (`installation:<id>` / `owner:<login>`), or `null`.
     *
     * The `ingest_install_bindings` row is the SINGLE source of install
     * ownership for this provider — `resolveBinding` reads it for the
     * per-install path and `GitHubWebhookDispatcherService` reads it for
     * the platform-App path through this accessor, so the consolidated
     * receiver never grows a second binding store. Best-effort: a lookup
     * failure resolves to "not bound" rather than throwing on a public,
     * unauthenticated endpoint.
     */
    async installBindingFor(key: string): Promise<{ userId: string } | null> {
        const bound = await this.installBindings
            .findByWorkspace(GITHUB_BINDING_PROVIDER, key)
            .catch(() => null);
        return bound ? { userId: bound.userId } : null;
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

        // Trusted review bots (R16) - an inline finding or a summary
        // comment from an allow-listed reviewer bot is rejection feedback
        // for the Task, on the same footing as a human's. It is handled
        // here, BEFORE normalize(), for the same reason a review is: the
        // loop must never review its reviewers, so the comment cannot
        // become a `github.mention` no matter what it says.
        if (
            (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') &&
            body.action === 'created' &&
            classifyReviewer(body.comment?.user, this.reviewBotPolicy()) === 'trusted-bot'
        ) {
            await this.recordBotCommentFeedback(binding, eventName, body);
            return { ingested: null };
        }

        // Git activity ingestion (audit item j) - pushes, the commits
        // inside them and merged pull requests. They take the SAME path
        // every other kind takes (envelope -> dedupe-insert -> spine
        // drain -> Activity row), but they never enter the review loop:
        // the code has already landed, there is nothing left to review.
        if (isGitActivityDelivery(eventName, body)) {
            const envelopes = await this.gitActivityEnvelopes(binding, eventName, body);
            if (envelopes.length === 0) {
                return { ingested: null };
            }
            return { ingested: await this.eventIngestService.ingest(binding.userId, envelopes) };
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
     * miss here (not a rejection, a dropped reviewer, an empty body, a PR
     * that maps to no Work/Task) is an ORDINARY outcome, not an error.
     *
     * Trusted review bots (R16): the platform's own identity and any bot
     * NOT on the allow-list are dropped — the loop must never treat its
     * own output as reviewer feedback. An allow-listed reviewer bot in
     * "request changes" mode is a rejection exactly like a human's, with
     * the bot's own severity marker carried along; its `COMMENTED`
     * summaries are not (their findings arrive as inline comments and are
     * recorded by {@link recordBotCommentFeedback}).
     */
    private async recordReviewRejection(
        binding: GitHubEventsBinding,
        body: GitHubWebhookBody,
    ): Promise<void> {
        const review = body.review;
        if (!review || review.state?.toLowerCase() !== 'changes_requested') return;
        const who = classifyReviewer(review.user, this.reviewBotPolicy());
        if (who === 'self' || who === 'untrusted-bot') return;
        const raw = review.body ?? '';
        if (who === 'trusted-bot' && isReviewBotNoise(raw)) return;
        const feedback = (who === 'trusted-bot' ? stripReviewBotMarkup(raw) : raw).trim();
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
                reviewerKind: who === 'trusted-bot' ? 'bot' : 'human',
                severity: who === 'trusted-bot' ? parseReviewBotSeverity(raw) : null,
            });
        } catch (error) {
            this.logger.warn(
                `PR rejection record failed for ${fullName}#${prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Trusted review bots (R16) — persist one inline finding
     * (`pull_request_review_comment`) or summary comment (`issue_comment`)
     * from an allow-listed reviewer bot as rejection feedback for the
     * Task the PR belongs to. The caller has already classified the
     * author as `trusted-bot` and checked `action === 'created'`.
     *
     * Status chatter (rate limits, "too many files", usage caps) is
     * dropped: it carries nothing to fix. Presentation markup — HTML
     * comments, collapsed static-analysis dumps, badges — is stripped
     * BEFORE the text cap so the finding itself survives the budget, and
     * an inline finding is prefixed with its `path:line` anchor. Same
     * best-effort posture as {@link recordReviewRejection}.
     */
    private async recordBotCommentFeedback(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<void> {
        const comment = body.comment;
        if (!comment || typeof comment.id !== 'number') return;
        const raw = comment.body ?? '';
        if (isReviewBotNoise(raw)) return;
        // issue_comment fires for plain issues too — only PR threads carry
        // review feedback.
        const prNumber =
            eventName === 'issue_comment'
                ? body.issue?.pull_request
                    ? body.issue?.number
                    : undefined
                : body.pull_request?.number;
        if (typeof prNumber !== 'number') return;

        const fullName = body.repository?.full_name ?? '';
        const [owner, repo] = fullName.split('/');
        if (!owner || !repo) return;

        const stripped = stripReviewBotMarkup(raw);
        const feedback =
            eventName === 'pull_request_review_comment'
                ? formatInlineFinding(comment, stripped)
                : stripped;
        if (feedback.length === 0) return;

        try {
            await this.rejections.recordPullRequestRejection({
                userId: binding.userId,
                owner,
                repo,
                prNumber,
                feedback: feedback.slice(0, GITHUB_EVENT_TEXT_MAX_CHARS),
                reviewerLabel: comment.user?.login ?? null,
                prUrl:
                    comment.html_url ?? body.pull_request?.html_url ?? body.issue?.html_url ?? null,
                reviewerKind: 'bot',
                severity: parseReviewBotSeverity(raw),
            });
        } catch (error) {
            this.logger.warn(
                `Reviewer-bot feedback record failed for ${fullName}#${prNumber}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * The allow-list and the self identity, resolved per delivery so an
     * operator's env change (and a spec's) takes effect without a restart.
     * Both sets hold canonical (lower-case) logins.
     */
    private reviewBotPolicy(): ReviewBotPolicy {
        return {
            trusted: new Set(config.githubReviewBots.trustedLogins()),
            self: new Set(config.githubReviewBots.selfLogins()),
        };
    }

    /**
     * Git activity ingestion (audit item j) — every envelope one push /
     * merge delivery produces, in ingest order.
     *
     * A push yields one `github.push` envelope for the ref plus one
     * `github.commit` envelope per new commit; a merged pull request
     * yields a single `github.merge`. An empty array means "nothing to
     * ingest" (unattributable repo, a tag ref, a branch deletion) and is
     * an ORDINARY outcome — the delivery still answers 200.
     */
    private async gitActivityEnvelopes(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<IngestedEventEnvelope[]> {
        return eventName === 'push'
            ? this.pushEnvelopes(binding, body)
            : this.mergeEnvelopes(binding, body);
    }

    /** `push` → the ref envelope + one envelope per NEW commit. */
    private async pushEnvelopes(
        binding: GitHubEventsBinding,
        body: GitHubWebhookBody,
    ): Promise<IngestedEventEnvelope[]> {
        const fullName = body.repository?.full_name ?? '';
        const [owner, repo] = fullName.split('/');
        if (!owner || !repo) return [];

        const ref = typeof body.ref === 'string' ? body.ref : '';
        // Branch pushes only. Tag and note refs are release/annotation
        // bookkeeping, not "someone pushed work to this repository".
        if (!ref.startsWith('refs/heads/')) return [];
        // A branch DELETION carries the all-zero `after` sha and no
        // commits. It is a cleanup, not a push of work.
        if (body.deleted === true) return [];
        const branch = ref.slice('refs/heads/'.length);
        const after = typeof body.after === 'string' ? body.after : '';
        if (!branch || !after) return [];

        // Task routing, where the payload allows it: the worktree-per-Task
        // path stamps `tasks.branchRef`, so the branch IS the Task key.
        const link = await this.taskLinks.findByBranch({
            userId: binding.userId,
            owner,
            repo,
            branch,
        });

        // `distinct: false` commits already reached the repository on
        // another ref — ingesting them again would re-announce work the
        // feed has shown once.
        const commits = (Array.isArray(body.commits) ? body.commits : [])
            .filter((commit) => typeof commit?.id === 'string' && commit.id.length > 0)
            .filter((commit) => commit.distinct !== false)
            .slice(0, GITHUB_PUSH_COMMITS_MAX);
        const pusher = body.pusher?.name ?? body.sender?.login ?? 'unknown';
        const headTimestamp = body.head_commit?.timestamp ?? commits[commits.length - 1]?.timestamp;

        const pushEnvelope: IngestedEventEnvelope = {
            id: randomUUID(),
            source: GITHUB_PLUGIN_ID,
            sourceEventId: cappedEventId(`push:${fullName}@${after}:${branch}`),
            kind: 'github.push',
            occurredAt: isoOrNow(headTimestamp),
            actor: { name: pusher },
            subject: {
                type: 'branch',
                externalId: capped(`${fullName}@${branch}`, GITHUB_SUBJECT_EXTERNAL_ID_MAX_CHARS),
                title: `${branch} (${commits.length} commit${commits.length === 1 ? '' : 's'})`,
            },
            workHint: { kind: 'repo', externalId: fullName },
            ...(body.compare ? { sourceUrl: body.compare } : {}),
            payload: {
                repoFullName: fullName,
                ref,
                branch,
                ...(body.before ? { before: body.before } : {}),
                after,
                commitCount: commits.length,
                ...(body.created === true ? { created: true } : {}),
                ...(body.forced === true ? { forced: true } : {}),
                ...taskFields(link),
                commits: commits.map((commit) => ({
                    sha: commit.id,
                    message: commitSubject(commit.message).slice(0, 500),
                })),
            },
        };

        const commitEnvelopes = commits.map<IngestedEventEnvelope>((commit) => {
            const sha = commit.id as string;
            const subject = commitSubject(commit.message);
            const author = commit.author?.username ?? commit.author?.name ?? pusher;
            const filesChanged =
                (commit.added?.length ?? 0) +
                (commit.removed?.length ?? 0) +
                (commit.modified?.length ?? 0);
            return {
                id: randomUUID(),
                source: GITHUB_PLUGIN_ID,
                // A commit's identity is its SHA — a rebase produces a new
                // one, a re-delivery or a second ref carrying the same
                // commit dedupes to zero.
                sourceEventId: cappedEventId(`commit:${fullName}@${sha}`),
                kind: 'github.commit',
                occurredAt: isoOrNow(commit.timestamp),
                actor: { name: author },
                subject: {
                    type: 'commit',
                    externalId: sha,
                    ...(subject ? { title: subject.slice(0, 500) } : {}),
                },
                workHint: { kind: 'repo', externalId: fullName },
                ...(commit.url ? { sourceUrl: commit.url } : {}),
                payload: {
                    repoFullName: fullName,
                    ref,
                    branch,
                    sha,
                    ...(commit.message
                        ? { message: commit.message.slice(0, GITHUB_EVENT_TEXT_MAX_CHARS) }
                        : {}),
                    ...(filesChanged > 0 ? { filesChanged } : {}),
                    ...taskFields(link),
                },
            };
        });

        return [pushEnvelope, ...commitEnvelopes];
    }

    /** `pull_request` closed+merged → one `github.merge` envelope. */
    private async mergeEnvelopes(
        binding: GitHubEventsBinding,
        body: GitHubWebhookBody,
    ): Promise<IngestedEventEnvelope[]> {
        const fullName = body.repository?.full_name ?? '';
        const [owner, repo] = fullName.split('/');
        if (!owner || !repo) return [];

        const pr = body.pull_request;
        const prNumber = pr?.number;
        if (!pr || typeof prNumber !== 'number') return [];

        // Task routing: the agent-merge path stamps `tasks.prNumber`, so
        // `(Work, prNumber)` is the Task key — the same one the PR
        // rejection recorder uses.
        const link = await this.taskLinks.findByPullRequest({
            userId: binding.userId,
            owner,
            repo,
            prNumber,
        });

        const mergeCommitSha = pr.merge_commit_sha ?? '';
        return [
            {
                id: randomUUID(),
                source: GITHUB_PLUGIN_ID,
                sourceEventId: cappedEventId(
                    `merge:${fullName}#${prNumber}@${mergeCommitSha || 'merged'}`,
                ),
                kind: 'github.merge',
                occurredAt: isoOrNow(pr.merged_at),
                actor: { name: pr.merged_by?.login ?? body.sender?.login ?? 'unknown' },
                subject: {
                    type: 'pull_request',
                    externalId: `${fullName}#${prNumber}`,
                    ...(pr.title ? { title: pr.title } : {}),
                },
                workHint: { kind: 'repo', externalId: fullName },
                ...(pr.html_url ? { sourceUrl: pr.html_url } : {}),
                payload: {
                    repoFullName: fullName,
                    prNumber,
                    ...(mergeCommitSha ? { mergeCommitSha } : {}),
                    ...(pr.base?.ref ? { baseRef: pr.base.ref } : {}),
                    ...(pr.head?.ref ? { headRef: pr.head.ref } : {}),
                    ...(pr.title ? { title: pr.title.slice(0, 500) } : {}),
                    ...(pr.merged_by?.login ? { mergedBy: pr.merged_by.login } : {}),
                    ...taskFields(link),
                },
            },
        ];
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
            // replies) — the loop must not echo its own output. Trusted
            // reviewer bots (R16) were intercepted in handleEvent() and
            // recorded as feedback; whatever bot reaches this line is
            // either the platform itself or one nobody vouched for.
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
