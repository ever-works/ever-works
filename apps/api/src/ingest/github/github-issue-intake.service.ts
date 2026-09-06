import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { EventIngestService, type IngestResult } from '@ever-works/agent/ingest';
import {
    DependabotIncidentSource,
    type DependabotAlertWebhookBody,
} from '../incidents/dependabot-incident.source';
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

/** The ingested-event kind for GitHub issue activity (sibling of `github.pr`). */
export const GITHUB_ISSUE_EVENT_KIND = 'github.issue';

/**
 * `issues` actions that are worth an ingested event. `edited` only
 * counts when the TITLE changed (body edits are far too chatty and the
 * triage Task keeps the link, not a copy of the body); the rest are the
 * lifecycle a trigger author or the triage filer wants to see.
 */
export const GITHUB_ISSUE_ACTIONS: readonly string[] = [
    'opened',
    'reopened',
    'closed',
    'edited',
    'labeled',
    'unlabeled',
    'assigned',
    'unassigned',
];

/** The subset of a GitHub `issues` delivery the intake reads. */
export interface GitHubIssuesWebhookBody {
    action?: string;
    repository?: { full_name?: string; html_url?: string };
    sender?: { login?: string; type?: string };
    issue?: {
        number?: number;
        title?: string;
        body?: string | null;
        html_url?: string;
        state?: string;
        state_reason?: string | null;
        created_at?: string;
        updated_at?: string;
        closed_at?: string | null;
        user?: { login?: string; type?: string };
        labels?: Array<{ name?: string } | string>;
        assignees?: Array<{ login?: string }>;
        milestone?: { title?: string } | null;
        /** Present when the "issue" is really a pull request thread. */
        pull_request?: { url?: string } | null;
    };
    /** `labeled` / `unlabeled` */
    label?: { name?: string };
    /** `assigned` / `unassigned` */
    assignee?: { login?: string };
    /** `edited` */
    changes?: { title?: { from?: string }; body?: { from?: string } };
}

/**
 * Normalize one `issues` delivery into a `github.issue` envelope, or
 * null when it is not issue activity worth ingesting.
 *
 * Identity: `subject.externalId = '<owner/repo>#<number>'` (the same
 * shape the PR envelopes use) is the STABLE issue id the triage filer
 * dedupes Tasks on. `sourceEventId` carries a revision suffix
 * (`@<action>[:<label|assignee>]:<updated_at>`) so a re-label lands as a
 * NEW event that refreshes the existing Task, while an exact GitHub
 * redelivery dedupes to zero. The label / assignee rides in the
 * revision because GitHub fires one delivery per label with the SAME
 * `updated_at` when several are applied at once.
 */
export function normalizeGitHubIssue(body: GitHubIssuesWebhookBody): IngestedEventEnvelope | null {
    const action = nonEmpty(body?.action);
    if (!action || !GITHUB_ISSUE_ACTIONS.includes(action)) return null;

    const fullName = nonEmpty(body.repository?.full_name);
    const [owner, repo] = (fullName ?? '').split('/');
    if (!fullName || !owner || !repo) return null;

    const issue = body.issue;
    const number = issue?.number;
    if (!issue || typeof number !== 'number' || !Number.isFinite(number)) return null;
    // PR threads also fire `issues` (they ARE issues under the hood) —
    // the PR path already owns those.
    if (issue.pull_request) return null;

    const previousTitle = nonEmpty(body.changes?.title?.from);
    if (action === 'edited' && !previousTitle) return null;

    const title = nonEmpty(issue.title) ?? `Issue #${number}`;
    const label = nonEmpty(body.label?.name);
    const assignee = nonEmpty(body.assignee?.login);
    const labels = (Array.isArray(issue.labels) ? issue.labels : [])
        .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .slice(0, 50);
    const assignees = (Array.isArray(issue.assignees) ? issue.assignees : [])
        .map((entry) => entry?.login)
        .filter((login): login is string => typeof login === 'string' && login.length > 0)
        .slice(0, 50);
    const author = nonEmpty(issue.user?.login);
    const actor = nonEmpty(body.sender?.login) ?? author ?? 'unknown';
    const url = httpsUrl(issue.html_url);
    const updatedAt = isoOrNow(issue.updated_at ?? issue.created_at);
    const bodyText = typeof issue.body === 'string' ? issue.body : '';

    const revisionDetail =
        action === 'labeled' || action === 'unlabeled'
            ? label
            : action === 'assigned' || action === 'unassigned'
              ? assignee
              : undefined;
    const revision = [action, revisionDetail, updatedAt].filter(Boolean).join(':');

    return {
        id: randomUUID(),
        source: GITHUB_PLUGIN_ID,
        sourceEventId: capped(
            `issue:${fullName}#${number}@${revision}`,
            INGESTED_EVENT_SOURCE_EVENT_ID_MAX_CHARS,
        ),
        kind: GITHUB_ISSUE_EVENT_KIND,
        occurredAt: updatedAt,
        // Column-width caps enforced, not hoped for: `actorName` and
        // `subjectExternalId` are varchar(200), and an over-long value
        // fails the INSERT — on this public receiver that is a 500 plus
        // an endless GitHub redelivery, not a filed issue.
        actor: { name: capped(actor, INGESTED_EVENT_ACTOR_MAX_CHARS) },
        subject: {
            type: 'issue',
            externalId: capped(
                `${fullName}#${number}`,
                INGESTED_EVENT_SUBJECT_EXTERNAL_ID_MAX_CHARS,
            ),
            title: capped(title, INGESTED_EVENT_TITLE_MAX_CHARS),
        },
        // Work routing: the repository is the container, resolved
        // against the owning user's Works by the shared repo matcher.
        workHint: { kind: 'repo', externalId: fullName },
        ...(url ? { sourceUrl: url } : {}),
        payload: {
            action,
            repoFullName: fullName,
            issueNumber: number,
            title: capped(title, INGESTED_EVENT_TITLE_MAX_CHARS),
            ...(issue.state ? { state: issue.state } : {}),
            ...(issue.state_reason ? { stateReason: issue.state_reason } : {}),
            labels,
            assignees,
            ...(author ? { author } : {}),
            ...(url ? { url } : {}),
            ...(bodyText ? { body: capped(bodyText, INGESTED_EVENT_TEXT_MAX_CHARS) } : {}),
            ...(label ? { label } : {}),
            ...(assignee ? { assignee } : {}),
            ...(previousTitle
                ? { previousTitle: capped(previousTitle, INGESTED_EVENT_TITLE_MAX_CHARS) }
                : {}),
            ...(issue.milestone?.title ? { milestone: issue.milestone.title } : {}),
            ...(issue.closed_at ? { closedAt: isoOrNow(issue.closed_at) } : {}),
            createdAt: isoOrNow(issue.created_at),
            updatedAt,
        },
    };
}

/**
 * GitHub issue + Dependabot intake (self-build program note §6, R2).
 *
 * The defect this closes: an opened GitHub issue produced NOTHING. The
 * receiver handled `push`, `pull_request`, `pull_request_review` and
 * `issue_comment` only, so no ingested event existed for a trigger to
 * match and the founder's intake path ("file an issue, the fleet picks
 * it up") was dead even with triggers configured.
 *
 * This service registers itself as a {@link GitHubWebhookConsumer} on
 * the ONE GitHub receiver at boot, so it sees `issues` and
 * `dependabot_alert` deliveries on BOTH routes after the same signature
 * verification and the same install-binding attribution the PR-review
 * bridge gets — and only then. It normalizes them (`github.issue`, or
 * the cross-vendor `incident` kind through `DependabotIncidentSource`)
 * and dedupe-inserts through the event-ingest spine, where the trigger
 * matcher and the triage filer pick them up.
 */
@Injectable()
export class GitHubIssueIntakeService implements OnModuleInit, GitHubWebhookConsumer {
    private readonly logger = new Logger(GitHubIssueIntakeService.name);

    readonly events: readonly string[] = ['issues', 'dependabot_alert'];

    constructor(
        private readonly dispatcher: GitHubWebhookDispatcherService,
        private readonly eventIngestService: EventIngestService,
        private readonly dependabot: DependabotIncidentSource,
    ) {}

    onModuleInit(): void {
        this.dispatcher.registerConsumer(this);
    }

    /** Normalize + ingest one verified delivery. `ingested: null` = nothing to file. */
    async handle(
        binding: GitHubEventsBinding,
        eventName: string,
        body: GitHubWebhookBody,
    ): Promise<{ ingested: IngestResult | null }> {
        const envelope =
            eventName === 'issues'
                ? normalizeGitHubIssue(body as GitHubIssuesWebhookBody)
                : eventName === 'dependabot_alert'
                  ? this.dependabot.normalize(body as DependabotAlertWebhookBody)
                  : null;
        if (!envelope) {
            return { ingested: null };
        }

        const ingested = await this.eventIngestService.ingest(binding.userId, [envelope]);
        if (ingested.inserted > 0) {
            this.logger.log(
                `Ingested ${envelope.kind} ${envelope.subject?.externalId ?? envelope.sourceEventId} for user ${binding.userId}`,
            );
        }
        return { ingested };
    }
}
