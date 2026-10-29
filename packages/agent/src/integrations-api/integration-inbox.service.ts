import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
    INBOX_EMAIL_FROM_MAX_CHARS,
    INBOX_EMAIL_RECEIVED_AT_MAX_CHARS,
    INBOX_EMAIL_SUBJECT_MAX_CHARS,
    INBOX_EMAIL_TO_MAX_CHARS,
    INBOX_EXTERNAL_BODY_MAX_CHARS,
    INBOX_EXTERNAL_CHOICE_KINDS,
    INBOX_EXTERNAL_ID_MAX_CHARS,
    INBOX_EXTERNAL_ITEM_KINDS,
    INBOX_EXTERNAL_MAX_CHOICES,
    INBOX_MAX_OPTION_ID_CHARS,
    INBOX_MAX_OPTION_LABEL_CHARS,
    INBOX_MAX_REPLY_CHARS,
    INBOX_MAX_TITLE_CHARS,
    INBOX_SOURCE_LABEL_MAX_CHARS,
    isSafeInboxSourceUrl,
    type InboxItemEmailMeta,
    type InboxItemKind,
    type InboxItemOption,
    type InboxItemStatus,
    type IntegrationInboxItemDto,
} from '@ever-works/contracts';
import { DataSource, type EntityManager } from 'typeorm';
import { runWithClaimedAggregateVersion } from '../domain-events/domain-event-context';
import { DomainEventPublisher } from '../domain-events/domain-event-publisher.service';
import { toIntegrationInboxItemDto } from '../domain-events/domain-event-snapshots';
import { InboxItem } from '../entities/inbox-item.entity';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { User } from '../entities/user.entity';
import { requiresIndividualDecision } from '../agent-approvals/individual-decision';
import { ExternalRecordLinksService } from './external-record-links.service';
import { etagFor } from './if-match';
import {
    DuplicateExternalRefError,
    IntegrationDomainRuleError,
    IntegrationValidationError,
    ResourceNotFoundError,
    VersionMismatchError,
} from './integration-api.errors';
import { IntegrationResourcesService } from './integration-resources.service';
import { type KeysetPage, type KeysetQuery, readKeysetPage } from './keyset-cursor';

/**
 * `GET /inbox/items` (contract v1 B.6 "Inbox"): keyset paging plus the inbox
 * filters. The route validates `statuses` / `kinds` against the contracts'
 * `INBOX_ITEM_STATUSES` / `INBOX_ITEM_KINDS` before they get here.
 */
export interface IntegrationInboxListQuery extends KeysetQuery {
    /** Only the messages of this recipient. */
    readonly recipientUserId?: string | null;
    /** Only these statuses. Empty = every status except `archived` (unless `includeArchived`). */
    readonly statuses?: readonly string[];
    /** Only these kinds. Empty = every kind. */
    readonly kinds?: readonly string[];
    /** With no `statuses`, also list archived messages (default false, as every v1 list). */
    readonly includeArchived?: boolean;
}

/** One inbox message as the integration DTO, plus its `ETag`. */
export interface IntegrationInboxItem {
    readonly dto: IntegrationInboxItemDto;
    readonly etag: string;
    /** The recipient: replies and state changes act as this user only. */
    readonly recipientUserId: string;
}

/** Who files an integration item: the key, in the organization the request is pinned to. */
export interface ExternalInboxWriter {
    readonly organizationId: string;
    readonly tenantId: string;
    readonly integrationKeyId: string;
    /** `sourceLabel` when the request names none: the integration's product name ("Ever Gauzy"). */
    readonly defaultSourceLabel: string;
}

/** One answer button of an integration item (`choices[]`). */
export interface ExternalInboxChoice {
    readonly id: string;
    readonly label: string;
}

/** `POST /inbox/items` — an integration files one of ITS OWN Inbox items for a member. */
export interface ExternalInboxItemCreate {
    /** The integration's id of the item: unique per tenant and key, forever. */
    readonly externalId: string;
    readonly recipientUserId: string;
    readonly kind: string;
    readonly title: string;
    readonly body?: string | null;
    readonly sourceUrl?: string | null;
    readonly sourceLabel?: string | null;
    readonly related?: {
        readonly taskId?: string | null;
        readonly workId?: string | null;
        readonly goalId?: string | null;
    } | null;
    readonly email?: {
        readonly from: string;
        readonly to?: string | null;
        readonly subject: string;
        readonly receivedAt: string;
    } | null;
    readonly choices?: readonly ExternalInboxChoice[] | null;
    readonly occurredAt?: string | null;
}

/** The state an integration moves its own item to (`resolved` = recorded as `answered`). */
export type ExternalInboxState = 'open' | 'resolved' | 'archived';

/** `PATCH /inbox/items/:id` — the integration changes its own item (If-Match required). */
export interface ExternalInboxItemUpdate {
    readonly title?: string;
    readonly body?: string;
    readonly choices?: readonly ExternalInboxChoice[] | null;
    readonly state?: ExternalInboxState;
    /** Only with `state: 'resolved'`: the choice picked and / or a note, recorded as the answer. */
    readonly resolution?: { readonly choiceId?: string | null; readonly text?: string | null } | null;
}

/** What {@link IntegrationInboxService.createExternal} did. */
export interface ExternalInboxCreateResult {
    readonly item: IntegrationInboxItem;
    /** `false`: the `externalId` already named an item, returned unchanged (a replay). */
    readonly created: boolean;
}

/**
 * Inbox reads of `/api/integrations/v1` (EW-P3-1, contract v1 B.6 "Inbox"),
 * and the integration inbox push (an integration files and keeps its own
 * Inbox items in a member's Ever Works Inbox).
 *
 * An inbox item is ONE human's message (its recipient), not an organization
 * resource: it has no visibility, owner or teams. The integration principal
 * reads every recipient's messages in its pinned organization — the contract's
 * "all recipients in pinned orgs" — and never a message outside any
 * organization (`organizationId` null, a personal-scope message) or in another
 * organization (`404 not_found` by id, like every v1 resource).
 *
 * The DTO is the `inbox.item.*` event `data` mapper (`toIntegrationInboxItemDto`),
 * so a read and the event of the same version are identical.
 *
 * ## Integration items (`origin: 'integration'`)
 *
 * `createExternal` files an item for a MEMBER of the pinned organization
 * (`422 domain_rule` for anyone else), linked only to Tasks / Works / Goals
 * the integration can read in that organization (`422` otherwise), with every
 * text capped and stored as plain text and `sourceUrl` `https:` only. The
 * `externalId` de-duplicates forever (unique index on tenant + key +
 * externalId): a replay returns the existing item unchanged. `updateExternal`
 * changes an item only for the key that created it (`404` for any other item)
 * and only at the version the caller read (`If-Match`, `412` otherwise). Both
 * record their event in the write's own transaction, so it carries the
 * request's `X-Sync-Origin` and the integration's change-feed `excludeOrigin`
 * leaves its own writes out.
 */
@Injectable()
export class IntegrationInboxService {
    private readonly resources: IntegrationResourcesService;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        // Appended + @Optional: the read-only graphs (and their specs) keep working.
        @Optional() resources?: IntegrationResourcesService,
        @Optional() private readonly publisher?: DomainEventPublisher,
    ) {
        this.resources =
            resources ??
            new IntegrationResourcesService(dataSource, new ExternalRecordLinksService(dataSource));
    }

    async list(
        organizationId: string,
        query: IntegrationInboxListQuery,
    ): Promise<KeysetPage<IntegrationInboxItemDto>> {
        const qb = this.dataSource
            .getRepository(InboxItem)
            .createQueryBuilder('row')
            .where('row.organizationId = :organizationId', { organizationId });
        if (query.recipientUserId) {
            qb.andWhere('row.userId = :recipientUserId', {
                recipientUserId: query.recipientUserId,
            });
        }
        const statuses = query.statuses ?? [];
        if (statuses.length > 0) {
            qb.andWhere('row.status IN (:...statuses)', { statuses: [...statuses] });
        } else if (!query.includeArchived) {
            qb.andWhere('row.status != :archived', { archived: 'archived' });
        }
        const kinds = query.kinds ?? [];
        if (kinds.length > 0) {
            qb.andWhere('row.kind IN (:...kinds)', { kinds: [...kinds] });
        }
        const page = await readKeysetPage(qb, 'row', query);
        return {
            data: page.data.map((row) => toIntegrationInboxItemDto(row)),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        };
    }

    /** One message of the pinned organization (`404 not_found` for any other). */
    async get(organizationId: string, id: string): Promise<IntegrationInboxItem> {
        const row = await this.dataSource.getRepository(InboxItem).findOne({ where: { id } });
        if (!row || !row.organizationId || row.organizationId !== organizationId) {
            throw new ResourceNotFoundError('inbox_item', id);
        }
        return toItem(row);
    }

    // ── integration items ─────────────────────────────────────────────

    /**
     * `POST /inbox/items` — file the integration's own item for one member of
     * the pinned organization. A replayed `externalId` returns the existing
     * item UNCHANGED (`created: false`); an `externalId` this key already used
     * in another organization is `409 duplicate_external_ref`.
     */
    async createExternal(
        writer: ExternalInboxWriter,
        input: ExternalInboxItemCreate,
    ): Promise<ExternalInboxCreateResult> {
        const clean = normalizeExternalCreate(input, writer.defaultSourceLabel);
        const existing = await this.findExternal(writer, clean.externalId);
        if (existing) return { item: this.ownReplay(writer, existing), created: false };

        await this.assertRecipient(writer.organizationId, clean.recipientUserId);
        await this.assertRelated(writer.organizationId, clean.related);

        let id: string;
        try {
            id = await this.transaction(async (manager) => {
                const repository = manager.getRepository(InboxItem);
                const saved = await repository.save(
                    repository.create({
                        userId: clean.recipientUserId,
                        kind: clean.kind,
                        title: clean.title,
                        body: clean.body,
                        options: clean.options,
                        sourceType: 'integration',
                        origin: 'integration',
                        integrationKeyId: writer.integrationKeyId,
                        externalId: clean.externalId,
                        sourceUrl: clean.sourceUrl,
                        sourceLabel: clean.sourceLabel,
                        emailMeta: clean.email,
                        occurredAt: clean.occurredAt,
                        taskId: clean.related.taskId,
                        workId: clean.related.workId,
                        goalId: clean.related.goalId,
                        status: 'open' as InboxItemStatus,
                        unread: true,
                        tenantId: writer.tenantId,
                        organizationId: writer.organizationId,
                    }),
                );
                // In the write's transaction: the event commits with the row and
                // carries this request's X-Sync-Origin (the feed's loop guard).
                await this.publisher?.created(
                    manager,
                    'inbox_item',
                    saved.id,
                    'inbox.item.created',
                );
                return saved.id;
            });
        } catch (error) {
            // A concurrent create with the same externalId won the unique index:
            // answer its item, exactly like a replay.
            if (isUniqueViolation(error)) {
                const winner = await this.findExternal(writer, clean.externalId);
                if (winner) return { item: this.ownReplay(writer, winner), created: false };
            }
            throw error;
        }
        return { item: await this.get(writer.organizationId, id), created: true };
    }

    /**
     * `PATCH /inbox/items/:id` — the key that created an integration item
     * changes its text, its choices or its state. Any other item (a platform
     * item, another key's, another organization's) is `404 not_found`; a
     * version other than `expectedVersion` is `412 version_mismatch`, checked
     * again by a compare-and-set in the write's transaction.
     */
    async updateExternal(
        writer: ExternalInboxWriter,
        id: string,
        expectedVersion: number,
        patch: ExternalInboxItemUpdate,
    ): Promise<IntegrationInboxItem> {
        const row = await this.dataSource.getRepository(InboxItem).findOne({ where: { id } });
        if (
            !row ||
            row.organizationId !== writer.organizationId ||
            row.origin !== 'integration' ||
            !row.integrationKeyId ||
            row.integrationKeyId !== writer.integrationKeyId
        ) {
            throw new ResourceNotFoundError('inbox_item', id);
        }
        const current = Number(row.version) || 1;
        if (current !== expectedVersion) throw new VersionMismatchError(expectedVersion, current);

        const { set, changedFields, previous } = externalUpdateOf(row, patch);
        await this.transaction(async (manager) => {
            const escape = (name: string) => manager.connection.driver.escape(name);
            const result = await manager
                .createQueryBuilder()
                .update(InboxItem)
                .set({ ...set, version: () => `${escape('version')} + 1` })
                .where('id = :id', { id })
                .andWhere('version = :expected', { expected: expectedVersion })
                .execute();
            if ((result.affected ?? 0) === 0) {
                const now = await manager.getRepository(InboxItem).findOne({ where: { id } });
                throw new VersionMismatchError(expectedVersion, Number(now?.version) || 1);
            }
            // The compare-and-set above took the next version: the event carries it
            // instead of bumping again.
            if (this.publisher) {
                await runWithClaimedAggregateVersion(
                    { aggregateType: 'inbox_item', id, version: expectedVersion + 1 },
                    () =>
                        this.publisher!.changed(manager, 'inbox_item', id, 'inbox.item.updated', {
                            changedFields,
                            previous,
                        }),
                );
            }
        });
        return this.get(writer.organizationId, id);
    }

    /**
     * Works-security lane 3a — whether answering this item would DECIDE A MERGE:
     * an approval backed by a `merge_pull_request` proposal (an agent's pull
     * request landing on a real branch, a release promotion, a release revert
     * — all of them go through that one proposal type). An integration relays
     * such an answer only with the `merges:decide` scope.
     *
     * Fails CLOSED: a proposal that cannot be read, or no longer exists, counts
     * as a merge, so a lookup hiccup never relays a merge decision without the
     * scope. An approval with no proposal behind it, a question, an escalation
     * and a notice are never merges.
     */
    async isMergeApproval(
        dto: Pick<IntegrationInboxItemDto, 'kind' | 'proposalId'>,
    ): Promise<boolean> {
        if (dto.kind !== 'approval' || !dto.proposalId) return false;
        try {
            const row = await this.dataSource
                .getRepository(AgentActionProposal)
                .findOne({ where: { id: dto.proposalId }, select: ['id', 'actionType'] });
            return !row || row.actionType === 'merge_pull_request';
        } catch {
            return true;
        }
    }

    /**
     * Works-security lane (integration API gates, finding 6) — which opt-in
     * decision scope answering this item needs, by the platform's own rule for
     * approvals that are never decided in bulk (`requiresIndividualDecision`):
     *
     * - `'merge'`: a `merge_pull_request` proposal (relayed only with
     *   `merges:decide`);
     * - `'individual'`: the release of a held Agent email draft, an agent's
     *   rewrite of its own identity files (SOUL.md / AGENTS.md), an
     *   agent-proposed closure of an escalation (relayed only with
     *   `decisions:individual` or `merges:decide`);
     * - `null`: anything else (questions, the owner's own escalations, notices,
     *   ordinary approvals) — `inbox:write` alone, as before.
     *
     * Fails CLOSED like {@link isMergeApproval}: a proposal that cannot be read,
     * or no longer exists, counts as a merge.
     */
    async decisionScopeOf(
        dto: Pick<IntegrationInboxItemDto, 'kind' | 'proposalId'>,
    ): Promise<'merge' | 'individual' | null> {
        if (dto.kind !== 'approval' || !dto.proposalId) return null;
        try {
            const row = await this.dataSource.getRepository(AgentActionProposal).findOne({
                where: { id: dto.proposalId },
                select: ['id', 'actionType', 'payload'],
            });
            if (!row || row.actionType === 'merge_pull_request') return 'merge';
            return requiresIndividualDecision(row) ? 'individual' : null;
        } catch {
            return 'merge';
        }
    }

    /**
     * Works-security lane 3a — record ON THE DECISION that an integration
     * relayed it: `payload.decisionRelay` on the decided proposal (the payload
     * is the proposal's free-form, display-and-audit column; no verifier binds
     * to it). Written only after the decision landed, and only when the decided
     * row really carries this recipient's decision, so an idempotent replay or
     * a lost race never rewrites somebody else's. Best-effort: the decision
     * stands whether or not the stamp could be written.
     */
    async recordRelayedDecision(
        proposalId: string,
        relay: { recipientUserId: string; integrationKeyId: string; integrationKind: string },
        now: Date = new Date(),
    ): Promise<boolean> {
        try {
            const repository = this.dataSource.getRepository(AgentActionProposal);
            const row = await repository.findOne({ where: { id: proposalId } });
            if (!row || row.status === 'pending' || row.decidedById !== relay.recipientUserId) {
                return false;
            }
            await repository.update(
                { id: proposalId },
                {
                    payload: {
                        ...(row.payload ?? {}),
                        decisionRelay: {
                            via: 'integration',
                            integrationKeyId: relay.integrationKeyId,
                            integrationKind: relay.integrationKind,
                            recordedAt: now.toISOString(),
                        },
                    },
                },
            );
            return true;
        } catch {
            return false;
        }
    }

    // ── internals ─────────────────────────────────────────────────────

    /** The item this key already filed under `externalId` (any organization), or `null`. */
    private findExternal(writer: ExternalInboxWriter, externalId: string): Promise<InboxItem | null> {
        return this.dataSource.getRepository(InboxItem).findOne({
            where: {
                tenantId: writer.tenantId,
                integrationKeyId: writer.integrationKeyId,
                externalId,
            },
        });
    }

    /** A replay answers the existing item, but never one of another organization. */
    private ownReplay(writer: ExternalInboxWriter, row: InboxItem): IntegrationInboxItem {
        if (row.organizationId !== writer.organizationId) {
            throw new DuplicateExternalRefError('external', row.id, row.externalId ?? '');
        }
        return toItem(row);
    }

    /**
     * The recipient must be an ACTIVE member of the pinned organization: on its
     * roster, or the tenant owner (on every roster without a row, as `GET
     * /members` lists them). Anyone else is `422 domain_rule`, so a key can never
     * put a message into the Inbox of somebody outside the organization.
     */
    private async assertRecipient(organizationId: string, userId: string): Promise<void> {
        const refuse = () =>
            new IntegrationDomainRuleError(
                'recipientUserId must be an active member of the pinned organization.',
                { field: 'recipientUserId' },
            );
        try {
            await this.resources.assertLinkTarget('member', organizationId, userId, 'inbox');
        } catch (error) {
            if (error instanceof ResourceNotFoundError) throw refuse();
            throw error;
        }
        const user = await this.dataSource
            .getRepository(User)
            .findOne({ where: { id: userId }, select: ['id', 'isActive'] });
        if (!user || !user.isActive) throw refuse();
    }

    /**
     * Every `related` id must name a record the integration can read in the
     * pinned organization (the same rule as `GET /tasks/:id` etc.: another
     * organization's record, or a private one, is refused) — `422 domain_rule`.
     */
    private async assertRelated(
        organizationId: string,
        related: NormalizedRelated,
    ): Promise<void> {
        const kinds = [
            ['taskId', 'task'],
            ['workId', 'work'],
            ['goalId', 'goal'],
        ] as const;
        for (const [field, kind] of kinds) {
            const value = related[field];
            if (!value) continue;
            try {
                await this.resources.get(kind, organizationId, value, 'inbox');
            } catch (error) {
                if (error instanceof ResourceNotFoundError) {
                    throw new IntegrationDomainRuleError(
                        `related.${field} must name a ${kind} of the pinned organization.`,
                        { field: `related.${field}` },
                    );
                }
                throw error;
            }
        }
    }

    private transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
        return this.publisher ? this.publisher.transaction(fn) : this.dataSource.transaction(fn);
    }
}

function toItem(row: InboxItem): IntegrationInboxItem {
    const dto = toIntegrationInboxItemDto(row);
    return { dto, etag: etagFor(dto.version), recipientUserId: row.userId };
}

// ── validation (defence in depth behind the route's DTOs) ─────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Control characters other than tab / newline / carriage return. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

interface NormalizedRelated {
    readonly taskId: string | null;
    readonly workId: string | null;
    readonly goalId: string | null;
}

interface NormalizedCreate {
    readonly externalId: string;
    readonly recipientUserId: string;
    readonly kind: InboxItemKind;
    readonly title: string;
    readonly body: string;
    readonly sourceUrl: string | null;
    readonly sourceLabel: string;
    readonly related: NormalizedRelated;
    readonly email: InboxItemEmailMeta | null;
    readonly options: InboxItemOption[] | null;
    readonly occurredAt: Date | null;
}

function invalid(path: string, reason: string): IntegrationValidationError {
    return new IntegrationValidationError(path, reason);
}

/** A required single-line-or-text field: a string, trimmed, non-empty, at most `max`. */
function requiredText(path: string, value: unknown, max: number): string {
    if (typeof value !== 'string') throw invalid(path, 'must be a string');
    const trimmed = value.trim();
    if (!trimmed) throw invalid(path, 'must not be empty');
    if (trimmed.length > max) throw invalid(path, `must be at most ${max} characters`);
    return trimmed;
}

function optionalText(path: string, value: unknown, max: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw invalid(path, 'must be a string');
    const trimmed = value.trim();
    if (trimmed.length > max) throw invalid(path, `must be at most ${max} characters`);
    return trimmed || null;
}

/** The body is markdown stored as plain text: refused past the cap, never truncated. */
function bodyText(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw invalid('body', 'must be a string');
    if (value.length > INBOX_EXTERNAL_BODY_MAX_CHARS) {
        throw invalid('body', `must be at most ${INBOX_EXTERNAL_BODY_MAX_CHARS} characters`);
    }
    return value;
}

function titleText(value: unknown): string {
    const title = requiredText('title', value, INBOX_MAX_TITLE_CHARS);
    if (/[\r\n]/.test(title)) throw invalid('title', 'must be one line');
    return title;
}

function optionalUuid(path: string, value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalid(path, 'must be a UUID');
    return value;
}

function choicesOf(kind: InboxItemKind, value: unknown): InboxItemOption[] | null {
    if (value === undefined || value === null) return null;
    if (!INBOX_EXTERNAL_CHOICE_KINDS.includes(kind)) {
        throw invalid('choices', 'are only for kind question or approval');
    }
    if (!Array.isArray(value)) throw invalid('choices', 'must be an array');
    if (value.length > INBOX_EXTERNAL_MAX_CHOICES) {
        throw invalid('choices', `must have at most ${INBOX_EXTERNAL_MAX_CHOICES} entries`);
    }
    const seen = new Set<string>();
    const out: InboxItemOption[] = [];
    value.forEach((raw: unknown, index) => {
        const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
            string,
            unknown
        >;
        const id = requiredText(`choices[${index}].id`, entry.id, INBOX_MAX_OPTION_ID_CHARS);
        const label = requiredText(
            `choices[${index}].label`,
            entry.label,
            INBOX_MAX_OPTION_LABEL_CHARS,
        );
        if (seen.has(id)) throw invalid(`choices[${index}].id`, 'must be unique');
        seen.add(id);
        out.push({ id, label });
    });
    return out.length > 0 ? out : null;
}

function emailOf(kind: InboxItemKind, value: unknown): InboxItemEmailMeta | null {
    if (value === undefined || value === null) return null;
    if (kind !== 'email') throw invalid('email', 'is only for kind email');
    if (typeof value !== 'object' || Array.isArray(value)) throw invalid('email', 'must be an object');
    const raw = value as Record<string, unknown>;
    const receivedAt = requiredText(
        'email.receivedAt',
        raw.receivedAt,
        INBOX_EMAIL_RECEIVED_AT_MAX_CHARS,
    );
    if (!Number.isFinite(Date.parse(receivedAt))) {
        throw invalid('email.receivedAt', 'must be an ISO 8601 date-time');
    }
    return {
        from: requiredText('email.from', raw.from, INBOX_EMAIL_FROM_MAX_CHARS),
        to: optionalText('email.to', raw.to, INBOX_EMAIL_TO_MAX_CHARS),
        subject: requiredText('email.subject', raw.subject, INBOX_EMAIL_SUBJECT_MAX_CHARS),
        receivedAt,
    };
}

/**
 * The create body, checked field by field. The route's DTO already refused
 * most of this (`400` with the same paths); the service refuses it again so
 * no other caller can put an oversize body, an unsafe link or a stray email
 * header into an Inbox.
 */
export function normalizeExternalCreate(
    input: ExternalInboxItemCreate,
    defaultSourceLabel: string,
): NormalizedCreate {
    const externalId = requiredText('externalId', input.externalId, INBOX_EXTERNAL_ID_MAX_CHARS);
    if (CONTROL_CHARS.test(externalId) || /[\r\n\t]/.test(externalId)) {
        throw invalid('externalId', 'must not contain control characters');
    }
    const recipientUserId = optionalUuid('recipientUserId', input.recipientUserId);
    if (!recipientUserId) throw invalid('recipientUserId', 'must be a user id (UUID)');
    if (!INBOX_EXTERNAL_ITEM_KINDS.includes(input.kind as InboxItemKind)) {
        throw invalid('kind', `must be one of ${INBOX_EXTERNAL_ITEM_KINDS.join(', ')}`);
    }
    const kind = input.kind as InboxItemKind;
    let sourceUrl: string | null = null;
    if (input.sourceUrl !== undefined && input.sourceUrl !== null && input.sourceUrl !== '') {
        if (!isSafeInboxSourceUrl(input.sourceUrl)) {
            throw invalid(
                'sourceUrl',
                'must be an absolute https URL without credentials, at most 2000 characters',
            );
        }
        sourceUrl = input.sourceUrl;
    }
    const sourceLabel =
        optionalText('sourceLabel', input.sourceLabel, INBOX_SOURCE_LABEL_MAX_CHARS) ??
        (defaultSourceLabel.trim().slice(0, INBOX_SOURCE_LABEL_MAX_CHARS) || 'Integration');
    let occurredAt: Date | null = null;
    if (input.occurredAt !== undefined && input.occurredAt !== null && input.occurredAt !== '') {
        const time =
            typeof input.occurredAt === 'string' ? Date.parse(input.occurredAt) : Number.NaN;
        if (!Number.isFinite(time)) throw invalid('occurredAt', 'must be an ISO 8601 date-time');
        occurredAt = new Date(time);
    }
    const related = input.related ?? {};
    if (typeof related !== 'object' || Array.isArray(related)) {
        throw invalid('related', 'must be an object');
    }
    return {
        externalId,
        recipientUserId,
        kind,
        title: titleText(input.title),
        body: bodyText(input.body),
        sourceUrl,
        sourceLabel,
        related: {
            taskId: optionalUuid('related.taskId', related.taskId),
            workId: optionalUuid('related.workId', related.workId),
            goalId: optionalUuid('related.goalId', related.goalId),
        },
        email: emailOf(kind, input.email),
        options: choicesOf(kind, input.choices),
        occurredAt,
    };
}

interface ExternalUpdatePlan {
    readonly set: Partial<Record<keyof InboxItem, unknown>>;
    readonly changedFields: string[];
    readonly previous: Record<string, unknown>;
}

/** The column changes of a PATCH, with the fields and previous values its event names. */
function externalUpdateOf(row: InboxItem, patch: ExternalInboxItemUpdate): ExternalUpdatePlan {
    const set: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    const change = (field: keyof InboxItem, value: unknown) => {
        set[field] = value;
        previous[field] = row[field] ?? null;
    };
    if (patch.title !== undefined) change('title', titleText(patch.title));
    if (patch.body !== undefined) change('body', bodyText(patch.body));
    if (patch.choices !== undefined) change('options', choicesOf(row.kind, patch.choices));
    const options = (
        patch.choices !== undefined ? set.options : row.options
    ) as InboxItemOption[] | null;

    if (patch.resolution !== undefined && patch.resolution !== null && patch.state !== 'resolved') {
        throw invalid('resolution', "is only for state 'resolved'");
    }
    if (patch.state !== undefined) {
        switch (patch.state) {
            case 'open':
                change('status', 'open');
                change('answeredAt', null);
                change('answerText', null);
                change('answerOptionId', null);
                break;
            case 'archived':
                change('status', 'archived');
                break;
            case 'resolved': {
                change('status', 'answered');
                // Handled in the integration's own app: it no longer waits on the
                // member, so it stops counting as unread here too.
                change('unread', false);
                if (!row.answeredAt) change('answeredAt', new Date());
                const resolution = patch.resolution ?? null;
                if (resolution) {
                    const choiceId = optionalText(
                        'resolution.choiceId',
                        resolution.choiceId,
                        INBOX_MAX_OPTION_ID_CHARS,
                    );
                    if (choiceId && !(options ?? []).some((option) => option.id === choiceId)) {
                        throw invalid('resolution.choiceId', "must be one of the item's choices");
                    }
                    const text = optionalText(
                        'resolution.text',
                        resolution.text,
                        INBOX_MAX_REPLY_CHARS,
                    );
                    change('answerOptionId', choiceId);
                    change('answerText', text);
                    change('answeredAt', new Date());
                }
                break;
            }
            default:
                throw invalid('state', 'must be open, resolved or archived');
        }
    }
    const changedFields = Object.keys(set);
    if (changedFields.length === 0) {
        throw invalid('body', 'must change at least one of title, body, choices, state');
    }
    // The previous values travel in the event as JSON: dates as ISO strings.
    for (const [key, value] of Object.entries(previous)) {
        if (value instanceof Date) previous[key] = value.toISOString();
    }
    return { set: set as ExternalUpdatePlan['set'], changedFields, previous };
}

/** Postgres `23505`, SQLite `UNIQUE constraint failed`, MySQL `ER_DUP_ENTRY`. */
function isUniqueViolation(error: unknown): boolean {
    const err = error as { code?: unknown; driverError?: { code?: unknown }; message?: unknown };
    const code = String(err?.code ?? err?.driverError?.code ?? '');
    if (code === '23505' || code === 'ER_DUP_ENTRY' || code.startsWith('SQLITE_CONSTRAINT')) {
        return true;
    }
    return typeof err?.message === 'string' && /UNIQUE constraint failed/i.test(err.message);
}
