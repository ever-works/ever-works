import {
    SHARED_VIEW_LIMITS,
    type PublishedActivityLineDto,
    type PublishedActorKind,
    type PublishedAgentDto,
    type PublishedAgentStatus,
    type PublishedColumnKey,
    type PublishedDocumentDto,
    type PublishedDocumentSummaryDto,
    type PublishedTaskCardDto,
    type PublishedTaskPriority,
} from '@ever-works/contracts/api';
import {
    isTaskStalled,
    TASK_BOARD_DEFAULT_STALL_AFTER_DAYS,
    type FeedEntryDto,
} from '@ever-works/contracts';
import { sanitizeNarrationParam } from '../activity-log/feed-narration';
import { sanitizeName } from '../utils/sanitize.util';
import { redactSecrets } from '../utils/secret-scan';
import { isActivityPublishable } from './publishable-activity';

/**
 * Shared view — the publish filters. THE SECURITY BOUNDARY.
 *
 * Each function takes a rich in-product row and returns a closed published
 * object built field by field. Nothing is spread and nothing is passed
 * through, so a field is published only when a line below names it: adding
 * a column to a Task, an Agent or an activity record can never leak it. The
 * specs assert the exact key set of every output.
 *
 * Deliberately never read: ids of any kind, the owner columns a Task is filed
 * under (Mission, Work, Idea, Team, Agent id, Goal), provenance, comments,
 * sub-tasks, run embeds beyond the run's status, cost and token telemetry,
 * branches, pull requests, repositories, paths, URLs, and every person.
 */

const PRIORITIES: readonly PublishedTaskPriority[] = ['p0', 'p1', 'p2', 'p3', 'p4'];
const TITLE_MAX = 200;
const LABEL_MAX = 40;
const NAME_MAX = 64;
const DOCUMENT_BODY_MAX = 200_000;

/** The narration params a published line may carry. Anything else is dropped. */
const PUBLISHED_NARRATION_PARAMS: ReadonlySet<string> = new Set([
    'actor',
    'subject',
    'hasSubject',
    'to',
]);

/** One line of display text: control characters and newlines removed, secrets redacted, capped. */
function publishText(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const redacted = redactSecrets(value).cleaned ?? '';
    return sanitizeName(redacted, max);
}

function toIso(value: Date | string | null | undefined, fallback: Date): string {
    const date = value instanceof Date ? value : value ? new Date(value) : fallback;
    return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

/** The minimal Task row a published card reads. Extra fields are ignored. */
export interface PublishableTaskRow {
    title: string;
    status: string;
    priority: string;
    labels?: string[] | null;
    updatedAt: Date | string;
    agentId?: string | null;
    latestRunStatus?: string | null;
    run?: { status?: string | null } | null;
}

export interface PublishTaskCardOptions {
    column: PublishedColumnKey;
    /** Display names of the Workspace's Agents, keyed by id. The id itself is never published. */
    agentNames: ReadonlyMap<string, string>;
    now: Date;
}

export function publishTaskCard(
    task: PublishableTaskRow,
    options: PublishTaskCardOptions,
): PublishedTaskCardDto {
    const priority = PRIORITIES.includes(task.priority as PublishedTaskPriority)
        ? (task.priority as PublishedTaskPriority)
        : 'p3';
    const labels = (Array.isArray(task.labels) ? task.labels : [])
        .map((label) => publishText(label, LABEL_MAX))
        .filter((label) => label.length > 0)
        .slice(0, SHARED_VIEW_LIMITS.cardLabelLimit);
    const agentName = task.agentId ? options.agentNames.get(task.agentId) : undefined;
    const runStatus = task.run?.status ?? task.latestRunStatus ?? null;

    return {
        title: publishText(task.title, TITLE_MAX),
        column: options.column,
        priority,
        labels,
        lastProgressAt: toIso(task.updatedAt, options.now),
        stale: isTaskStalled({
            status: task.status,
            latestRunStatus: runStatus,
            updatedAt: task.updatedAt,
            now: options.now,
            stallAfterDays: TASK_BOARD_DEFAULT_STALL_AFTER_DAYS,
        }),
        agent: agentName ? { name: publishText(agentName, NAME_MAX) } : null,
    };
}

/** The minimal Agent summary a roster row reads. */
export interface PublishableAgentRow {
    label: string;
    /** The Agent's own status (`active`, `running`, `paused`, …). */
    status: string;
}

export function publishAgent(
    agent: PublishableAgentRow,
    options: { inFlightCount: number },
): PublishedAgentDto {
    const inFlightCount =
        Number.isInteger(options.inFlightCount) && options.inFlightCount > 0
            ? options.inFlightCount
            : 0;
    let status: PublishedAgentStatus = 'idle';
    if (agent.status === 'paused') {
        status = 'paused';
    } else if (agent.status === 'running' || inFlightCount > 0) {
        status = 'working';
    }
    return {
        name: publishText(agent.label, NAME_MAX),
        status,
        inFlightCount,
    };
}

function publishedActorKind(kind: string | undefined): PublishedActorKind {
    if (kind === 'agent') return 'agent';
    if (kind === 'system') return 'system';
    // `user` and `external` are people. They are never named.
    return 'person';
}

/**
 * One Live Feed entry → one published strip line, or `null` when its kind is
 * not on the publishable allowlist (fail closed). Only an Agent is ever
 * named: for a person the actor is blanked in both the line and its params.
 */
export function publishActivityLine(entry: FeedEntryDto): PublishedActivityLineDto | null {
    if (!isActivityPublishable(entry.actionType)) return null;

    const actorKind = publishedActorKind(entry.actor?.kind);
    const actorName =
        actorKind === 'agent' && entry.actor?.label
            ? publishText(entry.actor.label, NAME_MAX) || null
            : null;

    const params: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(entry.narration?.params ?? {})) {
        if (!PUBLISHED_NARRATION_PARAMS.has(name) || name === 'actor') continue;
        if (typeof value === 'number') {
            params[name] = value;
        } else if (typeof value === 'string') {
            params[name] = sanitizeNarrationParam(value);
        }
    }
    params.actor = actorName ?? '';

    const key = typeof entry.narration?.key === 'string' ? entry.narration.key : 'fallback';
    return {
        actorKind,
        actorName,
        narration: { key: sanitizeNarrationParam(key), params },
        at: toIso(entry.createdAt, new Date()),
    };
}

/** The minimal Knowledge Base document a published summary reads. */
export interface PublishableDocumentRow {
    title: string;
    kbDocumentClass: string;
    wordCount?: number | null;
    updatedAt: Date | string;
}

export function publishDocumentSummary(
    document: PublishableDocumentRow,
    options: { ref: string; now: Date },
): PublishedDocumentSummaryDto {
    const wordCount =
        typeof document.wordCount === 'number' &&
        Number.isInteger(document.wordCount) &&
        document.wordCount > 0
            ? document.wordCount
            : 0;
    return {
        ref: options.ref,
        title: publishText(document.title, TITLE_MAX),
        documentClass: publishText(document.kbDocumentClass, NAME_MAX),
        wordCount,
        updatedAt: toIso(document.updatedAt, options.now),
    };
}

export function publishDocument(
    document: PublishableDocumentRow,
    options: { ref: string; body: string; now: Date },
): PublishedDocumentDto {
    const summary = publishDocumentSummary(document, options);
    const body = typeof options.body === 'string' ? options.body : '';
    return {
        ref: summary.ref,
        title: summary.title,
        documentClass: summary.documentClass,
        wordCount: summary.wordCount,
        updatedAt: summary.updatedAt,
        body: (redactSecrets(body).cleaned ?? '').slice(0, DOCUMENT_BODY_MAX),
    };
}
