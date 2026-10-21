import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { EventIngestService, type IngestResult } from '@ever-works/agent/ingest';
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

/** The ingested-event kind for pull-request activity (shared with the review bridge). */
export const GITHUB_PR_EVENT_KIND = 'github.pr';

/**
 * `pull_request` actions this intake turns into `github.pr` events (FL-15
 * spec FR-17). `opened` and `synchronize` stay the review bridge's: it
 * already ingests them (one event per pushed head), so this intake never
 * duplicates them.
 */
export const GITHUB_PR_INTAKE_ACTIONS: readonly string[] = [
    'review_requested',
    'review_request_removed',
    'assigned',
    'unassigned',
    'ready_for_review',
    'reopened',
    'closed',
];

/** The subset of a GitHub `pull_request` delivery the intake reads. */
export interface GitHubPullRequestWebhookBody {
    action?: string;
    repository?: { full_name?: string };
    sender?: { login?: string };
    /** `review_requested` / `review_request_removed` (a person; a team request has `requested_team`). */
    requested_reviewer?: { login?: string } | null;
    requested_team?: { slug?: string; name?: string } | null;
    /** `assigned` / `unassigned`. */
    assignee?: { login?: string } | null;
    pull_request?: {
        number?: number;
        title?: string;
        body?: string | null;
        html_url?: string;
        state?: string;
        draft?: boolean;
        merged?: boolean;
        user?: { login?: string };
        assignees?: Array<{ login?: string }>;
        requested_reviewers?: Array<{ login?: string }>;
        head?: { ref?: string; sha?: string; repo?: { full_name?: string; fork?: boolean } | null };
        base?: { ref?: string; repo?: { full_name?: string } };
        maintainer_can_modify?: boolean;
        author_association?: string;
        updated_at?: string;
        created_at?: string;
    };
}

function logins(entries: Array<{ login?: string }> | undefined): string[] {
    return (Array.isArray(entries) ? entries : [])
        .map((entry) => entry?.login)
        .filter((login): login is string => typeof login === 'string' && login.length > 0)
        .slice(0, 50);
}

/**
 * Normalize one `pull_request` delivery into a `github.pr` envelope (FL-15
 * spec FR-17), or null when the action is not one this intake owns.
 *
 * Identity: `subject.externalId = '<owner/repo>#<number>'` — the same subject
 * the review bridge's PR envelopes carry, so a Trigger's subject coalescing
 * treats every event about one pull request as one subject (spec U12).
 * `sourceEventId` carries the action, the login it concerns and the
 * `updated_at` revision, so a redelivery dedupes and a new request lands.
 *
 * The payload carries what the "about me" matcher and the hand-off read:
 * `requestedReviewer`, `assignee`, `assignees`, `author`, the head branch and
 * repository, whether it is a fork and whether the fork allows maintainer
 * edits (spec FR-20).
 */
export function normalizeGitHubPullRequest(body: GitHubPullRequestWebhookBody): IngestedEventEnvelope | null {
    const action = nonEmpty(body?.action);
    if (!action || !GITHUB_PR_INTAKE_ACTIONS.includes(action)) return null;
    const fullName = nonEmpty(body.repository?.full_name);
    const [owner, repo] = (fullName ?? '').split('/');
    if (!fullName || !owner || !repo) return null;
    const pr = body.pull_request;
    const number = pr?.number;
    if (!pr || typeof number !== 'number' || !Number.isFinite(number)) return null;

    const requestedReviewer = nonEmpty(body.requested_reviewer?.login);
    const requestedTeam = nonEmpty(body.requested_team?.slug ?? body.requested_team?.name);
    const assignee = nonEmpty(body.assignee?.login);
    const author = nonEmpty(pr.user?.login);
    const title = nonEmpty(pr.title) ?? `Pull request #${number}`;
    const url = httpsUrl(pr.html_url);
    const updatedAt = isoOrNow(pr.updated_at ?? pr.created_at);
    const headRepo = nonEmpty(pr.head?.repo?.full_name);
    const fork =
        pr.head?.repo?.fork === true || (headRepo !== undefined && headRepo.toLowerCase() !== fullName.toLowerCase());
    const actor = nonEmpty(body.sender?.login) ?? author ?? 'unknown';
    const revisionDetail =
        action === 'review_requested' || action === 'review_request_removed'
            ? (requestedReviewer ?? (requestedTeam ? `team:${requestedTeam}` : undefined))
            : action === 'assigned' || action === 'unassigned'
              ? assignee
              : undefined;
    const revision = [action, revisionDetail, updatedAt].filter(Boolean).join(':');
    const bodyText = typeof pr.body === 'string' ? pr.body : '';
    const authorAssociation = nonEmpty(pr.author_association)?.toUpperCase().slice(0, 40);

    return {
        id: randomUUID(),
        source: GITHUB_PLUGIN_ID,
        sourceEventId: capped(`pr-intake:${fullName}#${number}@${revision}`, INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS),
        kind: GITHUB_PR_EVENT_KIND,
        occurredAt: updatedAt,
        actor: { name: capped(actor, INGESTED_EVENT_ACTOR_MAX_CHARS) },
        subject: {
            type: 'pull_request',
            externalId: capped(`${fullName}#${number}`, INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS),
            title: capped(title, INGESTED_EVENT_TITLE_MAX_CHARS),
        },
        workHint: { kind: 'repo', externalId: fullName },
        ...(url ? { sourceUrl: url } : {}),
        payload: {
            action,
            repoFullName: fullName,
            prNumber: number,
            title: capped(title, INGESTED_EVENT_TITLE_MAX_CHARS),
            ...(pr.state ? { state: pr.state } : {}),
            ...(pr.draft === true ? { draft: true } : {}),
            ...(pr.merged === true ? { merged: true } : {}),
            ...(author ? { author } : {}),
            ...(authorAssociation ? { authorAssociation } : {}),
            ...(requestedReviewer ? { requestedReviewer } : {}),
            ...(requestedTeam ? { requestedTeam } : {}),
            ...(assignee ? { assignee } : {}),
            assignees: logins(pr.assignees),
            requestedReviewers: logins(pr.requested_reviewers),
            ...(pr.head?.ref ? { headRef: pr.head.ref } : {}),
            ...(pr.head?.sha ? { headSha: pr.head.sha } : {}),
            ...(headRepo ? { headRepo } : {}),
            fork,
            maintainerCanModify: pr.maintainer_can_modify === true,
            ...(pr.base?.ref ? { baseRef: pr.base.ref } : {}),
            ...(url ? { url } : {}),
            ...(bodyText ? { body: capped(bodyText, INGESTED_EVENT_TEXT_MAX_CHARS) } : {}),
            updatedAt,
        },
    };
}

/**
 * Tasks on computers (FL-15 P3, spec FR-17, T-13) — the pull-request intake:
 * a registered {@link GitHubWebhookConsumer} on the one GitHub receiver (so
 * it sees `pull_request` deliveries after the same signature verification and
 * install-binding attribution as the review bridge), turning the actions the
 * bridge ignores — review requested / removed, assigned / unassigned, ready
 * for review, reopened, closed — into `github.pr` events on the ingest spine,
 * where the "about me" Trigger matcher reads them.
 */
@Injectable()
export class GitHubPrIntakeService implements OnModuleInit, GitHubWebhookConsumer {
    private readonly logger = new Logger(GitHubPrIntakeService.name);

    readonly events: readonly string[] = ['pull_request'];

    constructor(
        private readonly dispatcher: GitHubWebhookDispatcherService,
        private readonly eventIngestService: EventIngestService,
    ) {}

    onModuleInit(): void {
        this.dispatcher.registerConsumer(this);
    }

    async handle(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<{ ingested: IngestResult | null }> {
        if (eventName !== 'pull_request') return { ingested: null };
        const envelope = normalizeGitHubPullRequest(body as unknown as GitHubPullRequestWebhookBody);
        if (!envelope) return { ingested: null };
        const ingested = await this.eventIngestService.ingest(binding.userId, [envelope]);
        if (ingested.inserted > 0) {
            this.logger.log(
                `Ingested ${envelope.kind} ${String(envelope.payload?.action ?? '')} ${envelope.subject?.externalId ?? ''} for user ${binding.userId}`,
            );
        }
        return { ingested };
    }
}
