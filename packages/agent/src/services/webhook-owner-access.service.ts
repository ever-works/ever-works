import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import {
    INTEGRATION_API_KEY_KIND,
    recipientScopeForEventType,
    type VisibilityAggregate,
} from '@ever-works/contracts';
import { Agent } from '../entities/agent.entity';
import { ApiKey } from '../entities/api-key.entity';
import { Goal } from '../entities/goal.entity';
import { Mission } from '../entities/mission.entity';
import { Organization } from '../entities/organization.entity';
import { OrganizationMember } from '../entities/organization-member.entity';
import { Task } from '../entities/task.entity';
import { TaskApprover } from '../entities/task-approver.entity';
import { TaskAssignee } from '../entities/task-assignee.entity';
import { TaskReviewer } from '../entities/task-reviewer.entity';
import { TaskWatcher } from '../entities/task-watcher.entity';
import { Team } from '../entities/team.entity';
import { TeamMember } from '../entities/team-member.entity';
import { Tenant } from '../entities/tenant.entity';
import { User } from '../entities/user.entity';
import type { WebhookSubscription } from '../entities/webhook-subscription.entity';
import { Work } from '../entities/work.entity';
import { WorkKnowledgeDocument } from '../entities/work-knowledge-document.entity';
import { WorkMember } from '../entities/work-member.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { RecordAccessPolicy } from '../record-visibility/record-access-policy.service';
import type { RecordAccessContext } from '../record-visibility/record-access.types';
import { effectiveIntegrationKeyPins } from './integration-key-pins';

/** Whether a v2 subscription's owner may receive events right now, and of which organizations. */
export interface WebhookOwnerAccess {
    readonly ok: boolean;
    /** Not ok AND for good (owner gone, key revoked or expired): mark the subscription `disabled`. */
    readonly disable: boolean;
    /** The organizations the owner can still see; empty when not ok. */
    readonly organizationIds: ReadonlySet<string>;
    /**
     * An integration-key owner's granted scopes (EW-P3-1: the recipient-scoped
     * domains `inbox.*` / `email.*` need their read scope). Absent for a user
     * owner, which never receives those events.
     */
    readonly scopes?: ReadonlySet<string> | null;
    /**
     * A user owner's id (absent for an integration key). Each event is checked
     * against what this user may read in the app ({@link WebhookOwnerAccessService.userMayRead}).
     */
    readonly userId?: string | null;
}

/** The parts of a v2 event (a `DomainEventEnvelope`) the user-owner read check needs. */
export interface WebhookEventRef {
    readonly type?: string | null;
    readonly organizationId?: string | null;
    readonly aggregate?: { readonly type?: string | null; readonly id?: string | null } | null;
    readonly data?: Record<string, unknown> | null;
}

const DENIED_FOR_NOW: WebhookOwnerAccess = {
    ok: false,
    disable: false,
    organizationIds: new Set(),
};
const DENIED_FOR_GOOD: WebhookOwnerAccess = {
    ok: false,
    disable: true,
    organizationIds: new Set(),
};

/** Aggregates whose rows carry a record visibility (EW-P1-3) and are read through `visibleTo`. */
const VISIBILITY_AGGREGATES: ReadonlySet<string> = new Set<VisibilityAggregate>([
    'task',
    'goal',
    'mission',
    'idea',
    'agent',
]);

/**
 * Webhooks v2 (EW-P1-5): who may still receive a subscription's events.
 *
 * Checked twice — when the fan-out creates a delivery, and again right
 * before each send (`WebhookSubscriptionDeliveryService`), so a delivery that
 * was queued, or is being retried, is never sent after its owner lost access:
 *  - a user owner receives only the organizations of its tenant it is a member
 *    of (roster row, or the Tenant owner), and only the events it could read in
 *    the app ({@link userMayRead}); a deleted user denies for good;
 *  - an integration-key owner must be active, unexpired and hold `events:read`
 *    (the scope of the change feed these events are the push form of), and is limited to
 *    the organizations it is pinned to (for an admin's key, the ones its creator
 *    still administers — EW-P2-6); a revoked, expired or deleted key denies for good.
 */
@Injectable()
export class WebhookOwnerAccessService {
    private accessPolicy: RecordAccessPolicy | null = null;

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async resolve(sub: WebhookSubscription): Promise<WebhookOwnerAccess> {
        const ownerId = sub.ownerId ?? sub.accountId;
        if (sub.ownerType === 'integration_key') {
            const key = await this.dataSource
                .getRepository(ApiKey)
                .findOne({ where: { id: ownerId } });
            if (
                !key ||
                key.kind !== INTEGRATION_API_KEY_KIND ||
                !key.isActive ||
                (key.expiresAt && key.expiresAt.getTime() <= Date.now())
            ) {
                return DENIED_FOR_GOOD;
            }
            // Review 2026-10-17 F12: a webhook is the push form of the change feed, so its
            // key needs `events:read` exactly as `GET /events` does. Scopes never change
            // after a key is created, so a key without it is denied for good.
            const scopes = Array.isArray(key.scopes) ? key.scopes : [];
            if (!scopes.includes('events:read')) return DENIED_FOR_GOOD;
            // EW-P2-6 — an admin's key keeps only the pins its creator still administers
            // (a demoted or removed admin receives nothing; re-promotion restores it).
            const pinned = await effectiveIntegrationKeyPins(this.dataSource.manager, key);
            if (key.tenantId && pinned.length === 0) return DENIED_FOR_NOW;
            return {
                ok: true,
                disable: false,
                organizationIds: new Set(pinned),
                scopes: new Set(scopes),
            };
        }
        const user = await this.dataSource
            .getRepository(User)
            .findOne({ where: { id: ownerId }, select: ['id', 'tenantId'] });
        if (!user) return DENIED_FOR_GOOD;
        if (!user.tenantId) return DENIED_FOR_NOW;
        return {
            ok: true,
            disable: false,
            organizationIds: new Set(await this.memberOrganizationIds(user.id, user.tenantId)),
            userId: user.id,
        };
    }

    /**
     * {@link resolve} narrowed to one organization (`null`: no organization to
     * check, e.g. a test fire) and, with `eventType`, to the recipient scope
     * that type needs (EW-P3-1: `inbox.*` → `inbox:read`, `email.*` →
     * `email:read`): checked again right before each send, so a queued or
     * retried delivery is not sent after its key lost the scope. A user owner
     * also needs `event` (the envelope being sent): it must still be able to
     * read that event's record ({@link userMayRead}); without it, nothing of an
     * organization is sent to a user owner.
     */
    async canReceive(
        sub: WebhookSubscription,
        organizationId: string | null,
        eventType?: string | null,
        event?: WebhookEventRef | null,
    ): Promise<{ allowed: boolean; disable: boolean }> {
        const access = await this.resolve(sub);
        if (!access.ok) return { allowed: false, disable: access.disable };
        const recipientScope = eventType ? recipientScopeForEventType(eventType) : null;
        if (recipientScope && !access.scopes?.has(recipientScope)) {
            return { allowed: false, disable: false };
        }
        if (organizationId === null) return { allowed: true, disable: false };
        if (!access.organizationIds.has(organizationId)) return { allowed: false, disable: false };
        if (access.userId) {
            const allowed = event
                ? await this.userMayRead(access.userId, {
                      ...event,
                      type: event.type ?? eventType ?? null,
                      organizationId,
                  })
                : false;
            return { allowed, disable: false };
        }
        return { allowed: true, disable: false };
    }

    /**
     * Whether a user owner may receive this event: exactly what the user could
     * read in the app (review 2026-10-17 F2 / F3), so a user-owned subscription
     * (Settings → Webhooks) never carries more than the user's own screens.
     *
     *  - The user must be a member of the event's organization (roster row, or
     *    the Tenant owner).
     *  - Tasks, goals, missions, ideas and agents: the record must pass
     *    `visibleTo(user)` NOW (owner, participant, Team / Work reach for `team`,
     *    roster for `organization`). A record that is gone (a tombstone) is judged
     *    from the event's own snapshot.
     *  - Works (and a Work's KB documents): the Work's creator or one of its
     *    members (`WorkOwnershipService.hasAccess`).
     *  - Organization, member, Team and organization-library events: any member.
     *  - The id-only `*.visibility_changed` notice to `private`: any member (it
     *    carries no content, and tells a copy to stop syncing).
     *  - Anything else (recipient-scoped `inbox.*` / `email.*`, unknown types): no.
     */
    async userMayRead(userId: string, event: WebhookEventRef): Promise<boolean> {
        const organizationId = event.organizationId ?? null;
        const aggregateType = event.aggregate?.type ?? null;
        const aggregateId = event.aggregate?.id ?? null;
        if (!organizationId || !aggregateType || !aggregateId) return false;
        const context = await this.policy().contextFor(
            { kind: 'user', userId },
            { tenantId: null, organizationId },
        );
        if (!context.isOrganizationMember) return false;
        const data = event.data ?? null;
        if (
            typeof event.type === 'string' &&
            event.type.endsWith('.visibility_changed') &&
            data?.visibility === 'private'
        ) {
            return true;
        }
        switch (aggregateType) {
            case 'organization':
            case 'team':
            case 'kb_folder':
                return true;
            case 'work':
                return this.mayReadWork(aggregateId, userId, data);
            case 'kb_document':
                return this.mayReadKbDocument(aggregateId, userId, data);
            default:
                if (!VISIBILITY_AGGREGATES.has(aggregateType)) return false;
                return this.mayReadRecord(
                    aggregateType as VisibilityAggregate,
                    aggregateId,
                    userId,
                    context,
                    data,
                );
        }
    }

    // ── internals ─────────────────────────────────────────────────────

    /** The read policy, over this DataSource (the API and the worker both build this service from it alone). */
    private policy(): RecordAccessPolicy {
        if (!this.accessPolicy) {
            const repo = this.dataSource.getRepository.bind(this.dataSource);
            this.accessPolicy = new RecordAccessPolicy(
                repo(OrganizationMember),
                repo(Organization),
                repo(Tenant),
                repo(TeamMember),
                repo(Team),
                repo(WorkMember),
                repo(Work),
                repo(TaskAssignee),
                repo(TaskApprover),
                repo(TaskReviewer),
                repo(TaskWatcher),
                repo(Task),
                repo(Goal),
                repo(Mission),
                repo(WorkProposal),
                repo(Agent),
            );
        }
        return this.accessPolicy;
    }

    /** The organizations of the tenant the user is a member of: every one for the Tenant owner, else its roster rows. */
    private async memberOrganizationIds(userId: string, tenantId: string): Promise<string[]> {
        const orgs = await this.dataSource
            .getRepository(Organization)
            .find({ where: { tenantId }, select: ['id'] });
        const ids = orgs.map((org) => org.id);
        if (ids.length === 0) return [];
        const tenant = await this.dataSource
            .getRepository(Tenant)
            .findOne({ where: { id: tenantId }, select: { id: true, ownerUserId: true } });
        if (tenant?.ownerUserId === userId) return ids;
        const rows = await this.dataSource.getRepository(OrganizationMember).find({
            where: { userId, organizationId: In(ids) },
            select: { id: true, organizationId: true },
        });
        return [...new Set(rows.map((row) => row.organizationId))];
    }

    private async mayReadRecord(
        aggregate: VisibilityAggregate,
        id: string,
        userId: string,
        context: RecordAccessContext,
        data: Record<string, unknown> | null,
    ): Promise<boolean> {
        const policy = this.policy();
        const repository = policy.repositoryFor(aggregate);
        const exists = (await repository.count({ where: { id } })) > 0;
        if (!exists) return snapshotReadable(data, userId, context);
        const qb = repository
            .createQueryBuilder('rec')
            .select('rec.id')
            .where('rec.id = :ownerAccessRecordId', { ownerAccessRecordId: id });
        policy.applyVisibleTo(qb, 'rec', aggregate, context, 'organization', 'owa');
        return (await qb.getCount()) > 0;
    }

    /** `WorkOwnershipService.hasAccess`: the Work's creator, or a member (any role). */
    private async mayReadWork(
        workId: string,
        userId: string,
        data: Record<string, unknown> | null,
    ): Promise<boolean> {
        const work = await this.dataSource
            .getRepository(Work)
            .findOne({ where: { id: workId }, select: { id: true, userId: true } });
        if (!work) {
            // Gone (`work.deleted`): its own snapshot's owner and members.
            if (ownerIdOf(data) === userId) return true;
            const members = Array.isArray(data?.members) ? data.members : [];
            return members.some(
                (member) => (member as { userId?: unknown } | null)?.userId === userId,
            );
        }
        if (work.userId === userId) return true;
        return (
            (await this.dataSource.getRepository(WorkMember).count({ where: { workId, userId } })) >
            0
        );
    }

    /** An organization-library document: any member. A Work's document: that Work's readers. */
    private async mayReadKbDocument(
        id: string,
        userId: string,
        data: Record<string, unknown> | null,
    ): Promise<boolean> {
        const doc = await this.dataSource
            .getRepository(WorkKnowledgeDocument)
            .findOne({ where: { id }, select: { id: true, workId: true } });
        const workId = doc
            ? (doc.workId ?? null)
            : typeof data?.workId === 'string'
              ? data.workId
              : null;
        if (!workId) return true;
        return this.mayReadWork(workId, userId, null);
    }
}

function ownerIdOf(data: Record<string, unknown> | null): string | null {
    const owner = data?.owner as { id?: unknown } | null | undefined;
    return typeof owner?.id === 'string' ? owner.id : null;
}

/**
 * A record that no longer exists (its `*.deleted` tombstone), judged from the
 * event's own snapshot the way `visibleTo` judged the row: the owner; any member
 * for `organization`; a member of one of its Teams (or its Work) for `team`.
 */
function snapshotReadable(
    data: Record<string, unknown> | null,
    userId: string,
    context: RecordAccessContext,
): boolean {
    if (!data) return false;
    if (ownerIdOf(data) === userId) return true;
    if (data.visibility === 'organization') return context.isOrganizationMember;
    if (data.visibility !== 'team') return false;
    const teamIds = Array.isArray(data.teamIds) ? data.teamIds : [];
    if (teamIds.some((teamId) => context.teamIds.includes(teamId as string))) return true;
    return typeof data.workId === 'string' && context.workIds.includes(data.workId);
}
