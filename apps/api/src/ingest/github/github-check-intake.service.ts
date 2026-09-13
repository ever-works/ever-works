import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { EventIngestService, type IngestResult } from '@ever-works/agent/ingest';
import {
    TaskCiAutoResumeService,
    classifyCheckResult,
    computeCiFailureKey,
    type AutoResumeOutcome,
    type CheckVerdict,
    type CiCheckResultInput,
} from '@ever-works/agent/tasks-domain';
import {
    INGESTED_EVENT_ACTOR_MAX_CHARS,
    INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS,
    INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS,
    INGESTED_EVENT_TEXT_MAX_CHARS,
    INGESTED_EVENT_TITLE_MAX_CHARS,
    capped,
    httpsUrl,
    isoOrNow,
    nonEmpty,
} from '../ingest-envelope.util';
import {
    GITHUB_PLUGIN_ID,
    type GitHubEventsBinding,
    type GitHubWebhookBody,
} from './github-pr-review-bridge.service';
import {
    GitHubWebhookDispatcherService,
    type GitHubWebhookConsumer,
} from './github-webhook-dispatcher.service';
import { classifyReviewer, type ReviewBotPolicy } from './github-review-bots';
import { config } from '../../config/constants';

/** The ingested-event kind for CI results (sibling of `github.pr`). */
export const GITHUB_CHECK_EVENT_KIND = 'github.check';

/** The three vendor deliveries that report a CI result. */
export const GITHUB_CHECK_EVENTS: readonly string[] = ['check_run', 'check_suite', 'workflow_run'];

/**
 * Provider deliveries that mean "a reviewer said something about the
 * pull request". The PR-review bridge has ALREADY decided whether each
 * one is a durable rejection by the time this consumer runs (the
 * dispatcher awaits the review leg before the intake leg), so this
 * service never re-classifies a reviewer — it acts on the recorded row.
 */
export const GITHUB_REVIEW_EVENTS: readonly string[] = [
    'pull_request_review',
    'issue_comment',
    'pull_request_review_comment',
];

/** How much of a check's reported output rides along. */
export const CHECK_OUTPUT_SUMMARY_MAX_CHARS = 2000;

// ── payload shapes ──────────────────────────────────────────────────

interface CheckPullRequestRef {
    number?: number;
    /**
     * The pull request's head AT DELIVERY TIME. Present on every
     * same-repository check delivery and absent for forks. It is the only
     * thing in the payload that can say "this check ran against a commit
     * the branch has already moved past" without commit ancestry — see
     * `decideCiHead`.
     */
    head?: { sha?: string; ref?: string };
}

/** One pull request a delivery names, plus where that PR's head is now. */
export interface CheckPullRequestHead {
    number: number;
    headSha: string | null;
}

/** The subset of the three CI deliveries this intake reads. */
export interface GitHubCheckWebhookBody extends GitHubWebhookBody {
    check_run?: {
        id?: number;
        name?: string;
        status?: string;
        conclusion?: string | null;
        head_sha?: string;
        html_url?: string;
        details_url?: string;
        started_at?: string;
        completed_at?: string | null;
        app?: { slug?: string; name?: string };
        output?: { title?: string | null; summary?: string | null; text?: string | null };
        check_suite?: { id?: number; head_branch?: string | null; head_sha?: string };
        pull_requests?: CheckPullRequestRef[];
    };
    check_suite?: {
        id?: number;
        status?: string;
        conclusion?: string | null;
        head_sha?: string;
        head_branch?: string | null;
        created_at?: string;
        updated_at?: string;
        app?: { slug?: string };
        pull_requests?: CheckPullRequestRef[];
    };
    workflow_run?: {
        id?: number;
        name?: string;
        status?: string;
        conclusion?: string | null;
        head_sha?: string;
        head_branch?: string | null;
        run_attempt?: number;
        html_url?: string;
        event?: string;
        created_at?: string;
        updated_at?: string;
        run_started_at?: string;
        pull_requests?: CheckPullRequestRef[];
    };
}

/** What one normalized CI delivery yields. */
export interface NormalizedGitHubCheck {
    envelope: IngestedEventEnvelope;
    /** Everything the fix loop needs, minus the owner it resolves later. */
    signal: Omit<CiCheckResultInput, 'userId'>;
}

function prHeads(refs: CheckPullRequestRef[] | undefined): CheckPullRequestHead[] {
    return (Array.isArray(refs) ? refs : [])
        .filter(
            (ref): ref is CheckPullRequestRef & { number: number } =>
                typeof ref?.number === 'number' && Number.isFinite(ref.number),
        )
        .map((ref) => ({ number: ref.number, headSha: nonEmpty(ref.head?.sha) ?? null }))
        .slice(0, 20);
}

/**
 * Normalize a `check_run` / `check_suite` / `workflow_run` delivery into
 * a `github.check` envelope plus the fix loop's signal, or `null` when
 * the delivery is not a CI result this platform can place.
 *
 * ## Identity — the whole dedupe story
 *
 * The spine's ONLY dedupe is `(userId, source, sourceEventId)`, so the id
 * has to separate three things that look alike:
 *
 *   * a **redelivery** (GitHub retrying a delivery it got no 2xx for) —
 *     must dedupe to nothing. Same job, same state, same id.
 *   * a **state change** (`queued` → `completed`) — a genuinely new fact.
 *     The status (and conclusion) are in the id.
 *   * a **re-run** of the same commit — a new result, not a redelivery.
 *     `check_run.id` is fresh for a re-run and `workflow_run.run_attempt`
 *     counts them, so both are in the id. `head_sha` alone would collapse
 *     a re-run into its predecessor.
 *
 * The head SHA sits BEFORE the mutable parts so a truncation at the
 * `varchar(200)` column width trims the tail, not the part that makes the
 * id unique — the same reasoning the push id documents.
 */
export function normalizeGitHubCheck(
    eventName: string,
    body: GitHubCheckWebhookBody,
): NormalizedGitHubCheck | null {
    const fullName = nonEmpty(body.repository?.full_name);
    const [owner, repo] = (fullName ?? '').split('/');
    if (!fullName || !owner || !repo) return null;

    const actor =
        nonEmpty(body.sender?.login) ??
        nonEmpty(body.check_run?.app?.slug) ??
        nonEmpty(body.check_suite?.app?.slug) ??
        'github';

    let granularity: CiCheckResultInput['granularity'];
    let identity: string;
    let headSha: string | undefined;
    let headBranch: string | null = null;
    let status: string | undefined;
    let conclusion: string | undefined;
    let checkName: string;
    let occurredAtRaw: string | null | undefined;
    let url: string | undefined;
    let outputTitle: string | undefined;
    let outputSummary: string | undefined;
    let pulls: CheckPullRequestHead[];

    if (eventName === 'check_run') {
        const run = body.check_run;
        if (!run) return null;
        granularity = 'check_run';
        headSha = nonEmpty(run.head_sha);
        headBranch = nonEmpty(run.check_suite?.head_branch) ?? null;
        status = nonEmpty(run.status);
        conclusion = nonEmpty(run.conclusion ?? undefined);
        checkName = nonEmpty(run.name) ?? 'check';
        identity = `run:${run.id ?? 'unknown'}`;
        occurredAtRaw = run.completed_at ?? run.started_at;
        url = httpsUrl(run.html_url) ?? httpsUrl(run.details_url);
        outputTitle = nonEmpty(run.output?.title ?? undefined);
        // `output.text` is frequently empty and `summary` is what GitHub
        // Actions actually fills; individual annotations are NOT in the
        // payload (they need a second API call), so this is the whole of
        // the failing output a webhook can carry.
        outputSummary =
            nonEmpty(run.output?.summary ?? undefined) ?? nonEmpty(run.output?.text ?? undefined);
        pulls = prHeads(run.pull_requests);
    } else if (eventName === 'check_suite') {
        const suite = body.check_suite;
        if (!suite) return null;
        granularity = 'check_suite';
        headSha = nonEmpty(suite.head_sha);
        headBranch = nonEmpty(suite.head_branch ?? undefined) ?? null;
        status = nonEmpty(suite.status);
        conclusion = nonEmpty(suite.conclusion ?? undefined);
        checkName = nonEmpty(suite.app?.slug) ?? 'check suite';
        identity = `suite:${suite.id ?? 'unknown'}`;
        occurredAtRaw = suite.updated_at ?? suite.created_at;
        // A check suite payload carries no `html_url` at all — only the
        // API link, which is not a page a human can open, so no deep link
        // is stored rather than a misleading one.
        pulls = prHeads(suite.pull_requests);
    } else if (eventName === 'workflow_run') {
        const workflow = body.workflow_run;
        if (!workflow) return null;
        granularity = 'workflow_run';
        headSha = nonEmpty(workflow.head_sha);
        headBranch = nonEmpty(workflow.head_branch ?? undefined) ?? null;
        status = nonEmpty(workflow.status);
        conclusion = nonEmpty(workflow.conclusion ?? undefined);
        checkName = nonEmpty(workflow.name) ?? 'workflow';
        identity = `workflow:${workflow.id ?? 'unknown'}#${workflow.run_attempt ?? 1}`;
        occurredAtRaw = workflow.updated_at ?? workflow.run_started_at ?? workflow.created_at;
        url = httpsUrl(workflow.html_url);
        pulls = prHeads(workflow.pull_requests);
    } else {
        return null;
    }

    if (!headSha) return null;

    const verdict: CheckVerdict = classifyCheckResult({ status, conclusion });
    // A check that has not COMPLETED carries no verdict anybody can act
    // on, and it is roughly half of everything GitHub sends: this repo's
    // `ci.yml` runs ~15 job instances per pull request push, each of which
    // announces itself `queued`, then `in_progress`, then `completed`, and
    // the suite and workflow events restate every transition again. Each
    // ingested envelope is a REQUIRED activity_log write plus a
    // `saveMemory` call that is a paid embedding wherever a memory
    // provider is configured, so ingesting the intermediate states bought
    // tens of thousands of rows and embeddings a day, across six fleet
    // PCs and every other repository in the installation, for a signal
    // nothing reads. Dropped at the edge, before the spine and before any
    // Task lookup. The `completed` results — red, green and inconclusive
    // alike — are all still ingested, so an inbound trigger still sees
    // every CI verdict and the board still goes red.
    if (verdict === 'pending') return null;
    const occurredAt = isoOrNow(occurredAtRaw);
    const parsedReportedAt = occurredAtRaw ? new Date(occurredAtRaw) : null;
    const reportedAt =
        parsedReportedAt && !Number.isNaN(parsedReportedAt.getTime()) ? parsedReportedAt : null;
    const revision = [status ?? 'unknown', conclusion].filter(Boolean).join(':');

    return {
        envelope: {
            id: randomUUID(),
            source: GITHUB_PLUGIN_ID,
            sourceEventId: capped(
                `check:${fullName}@${headSha}:${identity}:${revision}`,
                INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS,
            ),
            kind: GITHUB_CHECK_EVENT_KIND,
            occurredAt,
            actor: { name: capped(actor, INGESTED_EVENT_ACTOR_MAX_CHARS) },
            subject: {
                type: 'check',
                // The head commit IS the CI subject: a pull request number
                // is absent on every fork delivery, and a branch is absent
                // there too.
                externalId: capped(
                    `${fullName}@${headSha}`,
                    INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS,
                ),
                title: capped(
                    `${checkName}: ${conclusion ?? status ?? 'unknown'}`,
                    INGESTED_EVENT_TITLE_MAX_CHARS,
                ),
            },
            // Work routing: the repository is the container, like every
            // other GitHub envelope. Without it a `workId`-scoped trigger
            // never sees the event.
            workHint: { kind: 'repo', externalId: fullName },
            ...(url ? { sourceUrl: url } : {}),
            payload: {
                granularity,
                repoFullName: fullName,
                headSha,
                ...(headBranch ? { headBranch } : {}),
                ...(status ? { status } : {}),
                ...(conclusion ? { conclusion } : {}),
                verdict,
                name: capped(checkName, INGESTED_EVENT_TITLE_MAX_CHARS),
                ...(pulls.length > 0 ? { pullRequests: pulls.map((pull) => pull.number) } : {}),
                ...(url ? { url } : {}),
                ...(outputTitle
                    ? { outputTitle: capped(outputTitle, INGESTED_EVENT_TITLE_MAX_CHARS) }
                    : {}),
                ...(outputSummary
                    ? { outputSummary: capped(outputSummary, INGESTED_EVENT_TEXT_MAX_CHARS) }
                    : {}),
                occurredAt,
            },
        },
        signal: {
            owner,
            repo,
            headSha,
            headBranch,
            prNumbers: pulls.map((pull) => pull.number),
            prHeads: pulls,
            // The PROVIDER's own time, or null. `occurredAt` above is
            // `isoOrNow`-substituted so the envelope is never rejected for
            // a missing timestamp — but a substituted `now` is always the
            // newest thing in any comparison, so handing it to the head
            // decision would make every undated delivery look like a fresh
            // push. The evaluator is told the truth instead.
            observedAt: reportedAt,
            verdict,
            granularity,
            checkName,
            conclusion: conclusion ?? status ?? 'unknown',
            url: url ?? null,
            outputTitle: outputTitle ?? null,
            outputSummary: outputSummary
                ? capped(outputSummary, CHECK_OUTPUT_SUMMARY_MAX_CHARS)
                : null,
            failureKey:
                verdict === 'failing'
                    ? computeCiFailureKey({
                          checkNames: [checkName],
                          output: [outputTitle, outputSummary].filter(Boolean).join('\n'),
                      })
                    : null,
        },
    };
}

/**
 * True when this delivery is a reviewer speaking about a pull request —
 * i.e. the shape slice AB records a durable rejection for.
 *
 * Deliberately structural, not a re-classification: whether the author
 * was a trusted bot, a human, or the platform's own identity is the
 * bridge's decision and it has already been made. This only avoids
 * pointless Task lookups for plain issue comments and for the review
 * states (`approved`, `commented`) that record nothing.
 */
export function isReviewFeedbackDelivery(
    eventName: string,
    body: GitHubWebhookBody,
    policy: ReviewBotPolicy,
): boolean {
    if (eventName === 'pull_request_review') {
        if (body.review?.state?.toLowerCase() !== 'changes_requested') return false;
        return isDoorbellAuthor(body.review?.user, policy);
    }
    if (eventName === 'pull_request_review_comment') {
        if (body.action !== 'created' || typeof body.pull_request?.number !== 'number')
            return false;
        return isDoorbellAuthor(body.comment?.user, policy);
    }
    if (eventName === 'issue_comment') {
        // GitHub reports PR threads as issues; only those carry
        // `issue.pull_request`, and only they can be a Task's PR.
        if (body.action !== 'created' || !body.issue?.pull_request) return false;
        return isDoorbellAuthor(body.comment?.user, policy);
    }
    return false;
}

/**
 * May THIS author's comment wake the fix loop?
 *
 * The bridge refuses `self` and `untrusted-bot` before it records
 * anything, and this consumer has to make the same judgement rather than
 * inherit it: a doorbell that accepts any author lets the platform's OWN
 * status comment on the pull request start a model run on a fleet PC —
 * the loop echoing itself, which is the exact property
 * `classifyReviewer` exists to protect. `untrusted-bot` is dropped for
 * the same reason it is dropped upstream: nothing it says was recorded,
 * so there is nothing of its to act on.
 */
function isDoorbellAuthor(
    user: { login?: string; type?: string } | undefined,
    policy: ReviewBotPolicy,
): boolean {
    const who = classifyReviewer(user, policy);
    return who === 'human' || who === 'trusted-bot';
}

/** The pull request number a review-shaped delivery is about. */
function reviewPrNumber(eventName: string, body: GitHubWebhookBody): number | null {
    const candidate =
        eventName === 'issue_comment' ? body.issue?.number : body.pull_request?.number;
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

/**
 * CI feedback and the autonomous fix loop (self-build slice AC, EW-806,
 * closes finding R17) — the INBOUND half.
 *
 * ## The defect this closes
 *
 * The GitHub receiver had no handling for `check_run`, `check_suite` or
 * `workflow_run` at all: a CI result never became an ingested event, no
 * inbound trigger could match one, and `tasks.ciState` was written only
 * by a two-minute poll and read only by the board. So the fleet opened a
 * pull request, CI went red, and six PCs sat idle waiting for a human.
 *
 * ## Shape
 *
 * A registered {@link GitHubWebhookConsumer}, not a new receiver and not
 * a dispatcher dependency: it sees deliveries on BOTH GitHub routes after
 * the same signature verification and the same install-binding
 * attribution the PR-review bridge gets, and the dispatcher's constructor
 * arity (pinned by `ingest.module.spec.ts`) is untouched.
 *
 * Two signals, one loop, one budget:
 *
 *   * **CI** — the three check deliveries become `github.check` envelopes
 *     on the ordinary spine (dedupe-insert → drain → Activity → trigger
 *     matcher), and a completed FAILURE is offered to
 *     {@link TaskCiAutoResumeService}.
 *   * **Review** — a `changes_requested` review or a review comment is
 *     ingested by nobody here (the bridge owns those and records the
 *     durable rejection); this consumer only nudges the same evaluator to
 *     act on the row the bridge just wrote.
 *
 * Every decision that can spend money lives in the evaluator, behind a
 * durable per-attempt budget. This file's job is to normalize honestly
 * and to hand over the coordinates.
 */
@Injectable()
export class GitHubCheckIntakeService implements OnModuleInit, GitHubWebhookConsumer {
    private readonly logger = new Logger(GitHubCheckIntakeService.name);

    readonly events: readonly string[] = [...GITHUB_CHECK_EVENTS, ...GITHUB_REVIEW_EVENTS];

    constructor(
        private readonly dispatcher: GitHubWebhookDispatcherService,
        private readonly eventIngestService: EventIngestService,
        // @Optional() so an install without the Tasks domain (or a spec
        // that only exercises normalization) ingests the events and
        // resumes nothing, rather than failing the delivery.
        @Optional() private readonly autoResume?: TaskCiAutoResumeService,
    ) {}

    onModuleInit(): void {
        this.dispatcher.registerConsumer(this);
    }

    /** Same operator allow-lists the review bridge classifies with. */
    private reviewBotPolicy(): ReviewBotPolicy {
        return {
            trusted: new Set(config.githubReviewBots.trustedLogins()),
            self: new Set(config.githubReviewBots.selfLogins()),
        };
    }

    async handle(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<{ ingested: IngestResult | null; autoResume?: AutoResumeOutcome }> {
        if (GITHUB_REVIEW_EVENTS.includes(eventName)) {
            return {
                ingested: null,
                autoResume: await this.handleReview(binding, eventName, body),
            };
        }

        const normalized = normalizeGitHubCheck(eventName, body as GitHubCheckWebhookBody);
        if (!normalized) return { ingested: null };

        const ingested = await this.eventIngestService.ingest(binding.userId, [
            normalized.envelope,
        ]);
        if (ingested.inserted > 0) {
            this.logger.log(
                `Ingested ${GITHUB_CHECK_EVENT_KIND} ${normalized.envelope.sourceEventId} for user ${binding.userId}`,
            );
        }

        // A confirmed redelivery is the ONE case worth short-circuiting:
        // the spine has already seen this exact result, so re-running the
        // Task lookup and the budget read would burn queries on a fact
        // nothing can act on. Every other outcome — including a salience
        // drop or a rejected envelope — still reaches the evaluator, whose
        // own durable claim is the real idempotency guard. Gating the loop
        // on `inserted > 0` alone would let an operator's salience filter
        // silently switch the fix loop off.
        if (ingested.inserted === 0 && ingested.duplicates > 0) {
            return { ingested };
        }
        if (!this.autoResume) return { ingested };

        const outcome = await this.autoResume.onCheckResult({
            userId: binding.userId,
            ...normalized.signal,
        });
        if (outcome.reason === 'resumed') {
            this.logger.log(
                `Task ${outcome.taskId}: CI red on ${normalized.signal.owner}/${normalized.signal.repo}@${normalized.signal.headSha} — resumed as run ${outcome.runId} (attempt ${outcome.attemptsUsed}/${outcome.maxAttempts}).`,
            );
        }
        return { ingested, autoResume: outcome };
    }

    private async handleReview(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<AutoResumeOutcome | undefined> {
        if (!this.autoResume) return undefined;
        if (!isReviewFeedbackDelivery(eventName, body, this.reviewBotPolicy())) return undefined;
        const fullName = nonEmpty(body.repository?.full_name);
        const [owner, repo] = (fullName ?? '').split('/');
        const prNumber = reviewPrNumber(eventName, body);
        if (!owner || !repo || prNumber === null) return undefined;
        const outcome = await this.autoResume.onReviewRejection({
            userId: binding.userId,
            owner,
            repo,
            prNumber,
        });
        if (outcome.reason === 'resumed') {
            this.logger.log(
                `Task ${outcome.taskId}: reviewer rejection on ${fullName}#${prNumber} — resumed as run ${outcome.runId} (attempt ${outcome.attemptsUsed}/${outcome.maxAttempts}).`,
            );
        }
        return outcome;
    }
}
