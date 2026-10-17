import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import { WebhookDeliveryRepository } from '../../database/repositories/webhook-delivery.repository';
import { WebhookSubscriptionRepository } from '../../database/repositories/webhook-subscription.repository';
import { DomainEventFeedService } from '../../domain-events/domain-event-feed.service';
import {
    DomainEventRecorder,
    type RecordDomainEventInput,
} from '../../domain-events/domain-event-recorder.service';
import { DomainEventRelayService } from '../../domain-events/domain-event-relay.service';
import { DomainEventRetentionService } from '../../domain-events/domain-event-retention.service';
import {
    createDomainEventsDataSource,
    ORG_A,
    ORG_B,
    resetDomainEventsTables,
    taskEventInput,
    TENANT,
} from '../../domain-events/__tests__/domain-events.test-helpers';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMember } from '../../entities/organization-member.entity';
import { PluginEventCursor } from '../../entities/plugin-event-cursor.entity';
import { Task } from '../../entities/task.entity';
import { Team } from '../../entities/team.entity';
import { TeamMember } from '../../entities/team-member.entity';
import { Tenant } from '../../entities/tenant.entity';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { WebhookDelivery } from '../../entities/webhook-delivery.entity';
import { WebhookSubscription } from '../../entities/webhook-subscription.entity';
import { WebhookOwnerAccessService } from '../webhook-owner-access.service';
import {
    WEBHOOKS_V2_CURSOR_ID,
    WebhookDomainEventFanoutService,
    type WebhookV2Enqueuer,
} from '../webhook-domain-event-fanout.service';

/**
 * Webhooks v2 fan-out (EW-P1-5) on SQLite: real recorder, relay, feed and
 * repositories; only the enqueue port is a double.
 */
describe('WebhookDomainEventFanoutService', () => {
    let dataSource: DataSource;
    let fanout: WebhookDomainEventFanoutService;
    let subscriptions: WebhookSubscriptionRepository;
    const enqueued: Array<{
        subscriptionId: string;
        eventName: string;
        payload: Record<string, unknown>;
    }> = [];
    const enqueuer: WebhookV2Enqueuer = {
        enqueueDelivery: async (payload) => {
            enqueued.push(payload);
            return null;
        },
    };
    const OWNER = randomUUID();
    const OTHER_TENANT = randomUUID();

    const record = async (overrides: Partial<RecordDomainEventInput> = {}) => {
        const recorder = new DomainEventRecorder();
        await dataSource.transaction((manager) =>
            recorder.record(manager, taskEventInput(overrides)),
        );
    };
    const dispatch = async () => {
        const relay = new DomainEventRelayService(
            dataSource,
            new DomainEventRetentionService(dataSource),
            new EventEmitter2(),
        );
        await relay.tick();
        await relay.stop();
    };
    const deliveries = () =>
        dataSource.getRepository(WebhookDelivery).find({ order: { createdAt: 'ASC' } });
    const subscribe = async (
        overrides: Partial<Parameters<WebhookSubscriptionRepository['createV2']>[0]> = {},
    ) =>
        subscriptions.createV2({
            // As WebhooksService.createV2 does: start after the current feed head.
            startAfterSeq: await new DomainEventFeedService(dataSource).head(),
            accountId: OWNER,
            ownerType: 'user',
            ownerId: OWNER,
            url: 'https://hooks.example.com/ever',
            secretEncrypted: 'secret',
            events: ['task.*'],
            organizationIds: [ORG_A],
            excludeOriginTags: [],
            description: null,
            ...overrides,
        });

    const addToRoster = (userId: string, organizationId: string) =>
        dataSource.getRepository(OrganizationMember).insert({
            organizationId,
            tenantId: TENANT,
            userId,
            role: 'member',
            invitedById: null,
            invitationId: null,
            joinedAt: new Date(),
        } as unknown as OrganizationMember);

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        subscriptions = new WebhookSubscriptionRepository(
            dataSource.getRepository(WebhookSubscription),
        );
    });

    beforeEach(async () => {
        // A fresh owner-access service per test: its read policy memoizes a user's
        // roster / Teams / Works for a moment, which would leak between tests.
        fanout = new WebhookDomainEventFanoutService(
            dataSource,
            subscriptions,
            new WebhookDeliveryRepository(dataSource.getRepository(WebhookDelivery)),
            new DomainEventFeedService(dataSource),
            new WebhookOwnerAccessService(dataSource),
            enqueuer,
        );
        await resetDomainEventsTables(dataSource);
        for (const table of [
            'webhook_deliveries',
            'webhook_subscriptions',
            'users',
            'organizations',
            'organization_members',
            'api_keys',
            'tasks',
            'team_members',
            'works',
            'work_members',
        ]) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        enqueued.length = 0;
        await dataSource.getRepository(Organization).insert([
            {
                id: ORG_A,
                tenantId: TENANT,
                slug: `a-${randomUUID().slice(0, 6)}`,
                displayName: 'A',
            },
            {
                id: ORG_B,
                tenantId: OTHER_TENANT,
                slug: `b-${randomUUID().slice(0, 6)}`,
                displayName: 'B',
            },
        ] as unknown as Organization[]);
        await dataSource.getRepository(User).insert({
            id: OWNER,
            username: 'owner',
            slug: `owner-${OWNER.slice(0, 6)}`,
            tenantId: TENANT,
        } as unknown as User);
        // A user owner receives only the organizations it is on the roster of.
        await addToRoster(OWNER, ORG_A);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('starts at the head: events before the first pass are not delivered', async () => {
        await record();
        await dispatch();
        await subscribe();
        expect(await fanout.catchUp()).toBe(0);
        const cursor = await dataSource
            .getRepository(PluginEventCursor)
            .findOneByOrFail({ pluginId: WEBHOOKS_V2_CURSOR_ID });
        expect(String(cursor.lastSeq)).toBe('1');
    });

    it('a first pass that runs after its batch was dispatched still delivers that batch', async () => {
        // The relay assigns positions, THEN hands the batch to the fan-out: a
        // cursor created at the head right then would skip it for good.
        await subscribe();
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(1);
        expect(await deliveries()).toHaveLength(1);
    });

    it('re-enqueues a fan-out delivery that was created but never enqueued', async () => {
        await fanout.catchUp();
        const sub = await subscribe();
        const repo = new WebhookDeliveryRepository(dataSource.getRepository(WebhookDelivery));
        const orphan = await repo.createPendingForEvent({
            subscriptionId: sub.id,
            accountId: OWNER,
            event: 'task.updated',
            eventId: 'evt_01JABZ3K9QW8E5R2T7Y4V6X0ZP',
            payload: { id: 'evt_01JABZ3K9QW8E5R2T7Y4V6X0ZP', type: 'task.updated' },
        });
        // Fresh: still inside the grace window, left alone.
        await fanout.catchUp();
        expect(enqueued).toEqual([]);
        await dataSource
            .getRepository(WebhookDelivery)
            .update({ id: orphan!.id }, { createdAt: new Date(Date.now() - 10 * 60 * 1000) });
        await fanout.catchUp();
        expect(enqueued.map((item) => item.subscriptionId)).toEqual([sub.id]);
    });

    it('delivers what matches the organization, type pattern and origin filter — once', async () => {
        await fanout.catchUp(); // cursor at the (empty) head
        const sub = await subscribe({ excludeOriginTags: ['gauzy:conn-1'] });
        await record({ type: 'task.updated' });
        await record({
            type: 'team.created',
            aggregate: { type: 'team', id: randomUUID(), version: 1 },
            data: { id: 'x', visibility: 'organization' },
        });
        await record({ type: 'task.updated', organizationId: ORG_B, tenantId: OTHER_TENANT });
        await record({ type: 'task.updated', originTag: 'gauzy:conn-1' });
        await record({ type: 'task.runtime_updated' });
        await dispatch();

        expect(await fanout.catchUp()).toBe(1);
        const rows = await deliveries();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            subscriptionId: sub.id,
            event: 'task.updated',
            status: 'pending',
        });
        expect(rows[0].eventId).toMatch(/^evt_/);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].payload).toMatchObject({
            id: rows[0].eventId,
            type: 'task.updated',
            organizationId: ORG_A,
            seq: '1',
        });

        // Re-running (at least once) creates nothing new.
        await dataSource
            .getRepository(PluginEventCursor)
            .update({ pluginId: WEBHOOKS_V2_CURSOR_ID }, { lastSeq: 0 });
        expect(await fanout.catchUp()).toBe(0);
        expect(await deliveries()).toHaveLength(1);
    });

    it('delivers an opt-in type only to a subscription that names it exactly', async () => {
        await fanout.catchUp();
        await subscribe({ events: ['task.runtime_updated'] });
        await subscribe({ events: ['*'] });
        await record({ type: 'task.runtime_updated' });
        await dispatch();
        expect(await fanout.catchUp()).toBe(1);
        expect((await deliveries()).map((row) => row.event)).toEqual(['task.runtime_updated']);
    });

    it('never delivers private aggregates, except the id-only visibility notice', async () => {
        await fanout.catchUp();
        await subscribe({ events: ['*'] });
        await record({ type: 'task.updated', visibility: 'private' });
        await record({
            type: 'task.visibility_changed',
            visibility: 'private',
            data: { id: 'x', visibility: 'private' },
        });
        await dispatch();
        await fanout.catchUp();
        expect((await deliveries()).map((row) => row.event)).toEqual(['task.visibility_changed']);
    });

    it('stops delivering when the user owner left the tenant, and disables it when the user is gone', async () => {
        await fanout.catchUp();
        const sub = await subscribe();
        await dataSource.getRepository(User).update({ id: OWNER }, { tenantId: OTHER_TENANT });
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(0);

        await dataSource.getRepository(User).delete({ id: OWNER });
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(0);
        expect((await subscriptions.findById(sub.id))?.status).toBe('disabled');
    });

    it('disables a subscription whose integration key was revoked', async () => {
        await fanout.catchUp();
        const keyId = randomUUID();
        await dataSource.getRepository(ApiKey).insert({
            id: keyId,
            userId: OWNER,
            name: 'gauzy',
            hashedKey: `h-${keyId}`,
            prefix: 'ew_int_x',
            isActive: false,
        } as unknown as ApiKey);
        const sub = await subscribe({ ownerType: 'integration_key', ownerId: keyId });
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(0);
        expect((await subscriptions.findById(sub.id))?.status).toBe('disabled');
    });

    it('delivers to an active integration key in its pinned organizations; a personal key never owns one', async () => {
        await fanout.catchUp();
        const insertKey = async (kind: string, organizationIds: string[] | null) => {
            const id = randomUUID();
            await dataSource.getRepository(ApiKey).insert({
                id,
                userId: OWNER,
                name: kind,
                hashedKey: `h-${id}`,
                prefix: 'ew_int_x',
                isActive: true,
                kind,
                organizationIds,
            } as unknown as ApiKey);
            return id;
        };
        const pinned = await subscribe({
            ownerType: 'integration_key',
            ownerId: await insertKey('integration', [ORG_A]),
        });
        const personal = await subscribe({
            ownerType: 'integration_key',
            ownerId: await insertKey('personal', null),
        });
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(1);
        expect((await deliveries()).map((row) => row.subscriptionId)).toEqual([pinned.id]);
        expect((await subscriptions.findById(personal.id))?.status).toBe('disabled');
    });

    it("an admin's key receives only in the organizations its creator still administers (EW-P2-6)", async () => {
        const admin = randomUUID();
        await dataSource.getRepository(Tenant).insert({
            id: TENANT,
            ownerUserId: OWNER,
            slug: `t-${TENANT.slice(0, 6)}`,
            displayName: 'Tenant',
        } as unknown as Tenant);
        await dataSource.getRepository(User).insert({
            id: admin,
            username: 'admin',
            slug: `admin-${admin.slice(0, 6)}`,
            tenantId: TENANT,
            isActive: true,
        } as unknown as User);
        const keyId = randomUUID();
        await dataSource.getRepository(ApiKey).insert({
            id: keyId,
            userId: admin,
            tenantId: TENANT,
            name: 'gauzy',
            hashedKey: `h-${keyId}`,
            prefix: 'ew_int_x',
            isActive: true,
            kind: 'integration',
            organizationIds: [ORG_A],
        } as unknown as ApiKey);
        const sub = await subscribe({ ownerType: 'integration_key', ownerId: keyId });
        const access = new WebhookOwnerAccessService(dataSource);
        try {
            // Not (or no longer) an admin of ORG_A: nothing is sent, but the
            // subscription is not disabled (a re-promotion restores it).
            expect(await access.canReceive(sub, ORG_A)).toEqual({ allowed: false, disable: false });
            await dataSource.getRepository(OrganizationMember).insert({
                organizationId: ORG_A,
                tenantId: TENANT,
                userId: admin,
                role: 'admin',
                invitedById: OWNER,
                invitationId: null,
                joinedAt: new Date(),
            } as unknown as OrganizationMember);
            expect(await access.canReceive(sub, ORG_A)).toEqual({ allowed: true, disable: false });
        } finally {
            await dataSource.query('DELETE FROM "organization_members"');
            await dataSource.query('DELETE FROM "tenants"');
        }
    });

    it('delivers inbox events only to an integration key holding inbox:read, never to a user-owned subscription', async () => {
        await fanout.catchUp();
        const insertKey = async (scopes: string[]) => {
            const id = randomUUID();
            await dataSource.getRepository(ApiKey).insert({
                id,
                userId: OWNER,
                name: 'gauzy',
                hashedKey: `h-${id}`,
                prefix: 'ew_int_x',
                isActive: true,
                kind: 'integration',
                organizationIds: [ORG_A],
                scopes,
            } as unknown as ApiKey);
            return id;
        };
        const withInbox = await subscribe({
            events: ['inbox.*', 'task.*'],
            ownerType: 'integration_key',
            ownerId: await insertKey(['events:read', 'webhooks:manage', 'inbox:read']),
        });
        const withoutInbox = await subscribe({
            events: ['inbox.*', 'task.*'],
            ownerType: 'integration_key',
            ownerId: await insertKey(['events:read', 'webhooks:manage', 'tasks:read']),
        });
        const userOwned = await subscribe({ events: ['inbox.*', 'task.*'] });
        const itemId = randomUUID();
        await record({
            type: 'inbox.item.answered',
            aggregate: { type: 'inbox_item', id: itemId, version: 2 },
            data: { id: itemId, recipientUserId: OWNER, status: 'answered' },
            visibility: 'recipient',
        });
        await record();
        await dispatch();
        await fanout.catchUp();
        const rows = (await deliveries()).map((row) => [row.subscriptionId, row.event]);
        expect(rows.filter(([, event]) => event === 'inbox.item.answered')).toEqual([
            [withInbox.id, 'inbox.item.answered'],
        ]);
        // Ordinary organization events still reach every matching subscription.
        expect(
            rows
                .filter(([, event]) => event === 'task.updated')
                .map(([id]) => id)
                .sort(),
        ).toEqual([withInbox.id, withoutInbox.id, userOwned.id].sort());

        // The send-time re-check applies the same rule (a queued or retried
        // delivery is not sent after the key lost the scope).
        const access = new WebhookOwnerAccessService(dataSource);
        const verdict = async (id: string, type: string) =>
            (await access.canReceive((await subscriptions.findById(id))!, ORG_A, type)).allowed;
        expect(await verdict(withInbox.id, 'inbox.item.answered')).toBe(true);
        expect(await verdict(withoutInbox.id, 'inbox.item.answered')).toBe(false);
        expect(await verdict(userOwned.id, 'inbox.item.answered')).toBe(false);
        expect(await verdict(withoutInbox.id, 'task.updated')).toBe(true);
    });

    describe('a user owner receives only what it could read in the app (review 2026-10-17 F2 / F3)', () => {
        const MEMBER = randomUUID();
        let teamId: string;

        const makeUser = (id: string, name: string) =>
            dataSource.getRepository(User).insert({
                id,
                username: name,
                slug: `${name}-${id.slice(0, 6)}`,
                tenantId: TENANT,
            } as unknown as User);
        const makeTask = async (overrides: Partial<Task>) => {
            const tasks = dataSource.getRepository(Task);
            return tasks.save(
                tasks.create({
                    userId: MEMBER,
                    slug: `T-${randomUUID().slice(0, 6)}`,
                    title: 'Team plan',
                    createdByType: 'user',
                    createdById: MEMBER,
                    tenantId: TENANT,
                    organizationId: ORG_A,
                    ...overrides,
                } as Partial<Task>),
            );
        };
        const taskEvent = (task: Task, visibility: string, type = 'task.updated') =>
            record({
                type,
                aggregate: { type: 'task', id: task.id, version: 2 },
                data: { id: task.id, title: task.title, visibility, teamIds: [teamId] },
                visibility,
            });
        const delivered = async () =>
            (await deliveries()).map((row) => [row.subscriptionId, row.event] as const);

        beforeEach(async () => {
            await makeUser(MEMBER, 'member');
            await addToRoster(MEMBER, ORG_A);
            const teams = dataSource.getRepository(Team);
            const team = await teams.save(
                teams.create({
                    userId: MEMBER,
                    name: 'Core',
                    slug: `core-${randomUUID().slice(0, 6)}`,
                    tenantId: TENANT,
                    organizationId: ORG_A,
                } as Partial<Team>),
            );
            teamId = team.id;
            await dataSource.getRepository(TeamMember).insert({
                teamId,
                memberType: 'user',
                memberId: MEMBER,
                tenantId: TENANT,
                organizationId: ORG_A,
            } as unknown as TeamMember);
        });

        it('skips the records of a Team for a user who is not on that Team', async () => {
            await fanout.catchUp();
            const outsider = await subscribe({ events: ['task.*'] });
            const onTeam = await subscribe({
                events: ['task.*'],
                accountId: MEMBER,
                ownerId: MEMBER,
            });
            const teamTask = await makeTask({
                teamId,
                visibility: 'team',
                visibilityExplicit: false,
            });
            const orgTask = await makeTask({
                visibility: 'organization',
                visibilityExplicit: true,
            });
            await taskEvent(teamTask, 'team');
            await taskEvent(orgTask, 'organization', 'task.created');
            await record({
                type: 'task.comment.created',
                aggregate: { type: 'task', id: teamTask.id, version: 3 },
                data: { id: randomUUID(), body: 'secret plan' },
                visibility: 'team',
            });
            await dispatch();
            await fanout.catchUp();

            const rows = await delivered();
            expect(rows.filter(([id]) => id === outsider.id).map(([, event]) => event)).toEqual([
                'task.created',
            ]);
            expect(
                rows
                    .filter(([id]) => id === onTeam.id)
                    .map(([, event]) => event)
                    .sort(),
            ).toEqual(['task.comment.created', 'task.created', 'task.updated']);
        });

        it('skips every event of an organization the user is not on the roster of', async () => {
            await dataSource.query('DELETE FROM "organization_members"');
            await fanout.catchUp();
            await subscribe();
            const orgTask = await makeTask({
                visibility: 'organization',
                visibilityExplicit: true,
            });
            await taskEvent(orgTask, 'organization');
            await dispatch();
            expect(await fanout.catchUp()).toBe(0);
        });

        it('the Tenant owner (a member without a roster row) still receives organization events', async () => {
            await dataSource.query('DELETE FROM "organization_members"');
            await dataSource.getRepository(Tenant).insert({
                id: TENANT,
                ownerUserId: OWNER,
                slug: `t-${TENANT.slice(0, 6)}`,
                displayName: 'Tenant',
            } as unknown as Tenant);
            await fanout.catchUp();
            await subscribe();
            const orgTask = await makeTask({
                visibility: 'organization',
                visibilityExplicit: true,
            });
            await taskEvent(orgTask, 'organization');
            await dispatch();
            expect(await fanout.catchUp()).toBe(1);
        });

        it('skips work.* events of a Work the user neither created nor is a member of', async () => {
            await fanout.catchUp();
            await subscribe({ events: ['work.*'] });
            const works = dataSource.getRepository(Work);
            const work = await works.save(
                works.create({
                    name: 'Payroll',
                    slug: `payroll-${randomUUID().slice(0, 6)}`,
                    userId: MEMBER,
                    description: 'private work',
                    tenantId: TENANT,
                    organizationId: ORG_A,
                } as Partial<Work>),
            );
            const workEvent = () =>
                record({
                    type: 'work.updated',
                    aggregate: { type: 'work', id: work.id, version: 2 },
                    data: { id: work.id, name: work.name, visibility: 'organization' },
                    visibility: 'organization',
                });
            await workEvent();
            await dispatch();
            expect(await fanout.catchUp()).toBe(0);

            await dataSource.getRepository(WorkMember).insert({
                workId: work.id,
                userId: OWNER,
                tenantId: TENANT,
                organizationId: ORG_A,
            } as unknown as WorkMember);
            await workEvent();
            await dispatch();
            expect(await fanout.catchUp()).toBe(1);
        });

        it('judges the tombstone of a deleted record from its own snapshot', async () => {
            await fanout.catchUp();
            await subscribe({ events: ['task.*'] });
            const onTeam = await subscribe({
                events: ['task.*'],
                accountId: MEMBER,
                ownerId: MEMBER,
            });
            const goneId = randomUUID();
            await record({
                type: 'task.deleted',
                aggregate: { type: 'task', id: goneId, version: 4 },
                data: { id: goneId, visibility: 'team', teamIds: [teamId], deleted: true },
                visibility: 'team',
            });
            await dispatch();
            await fanout.catchUp();
            expect((await delivered()).map(([id]) => id)).toEqual([onTeam.id]);
        });

        it('re-checks at send time: a record made private after the fan-out is not sent', async () => {
            const sub = await subscribe();
            const orgTask = await makeTask({
                visibility: 'organization',
                visibilityExplicit: true,
            });
            const envelope = {
                type: 'task.updated',
                organizationId: ORG_A,
                aggregate: { type: 'task', id: orgTask.id, version: 2 },
                data: { id: orgTask.id, visibility: 'organization' },
            };
            const verdict = async (event?: typeof envelope) =>
                (
                    await new WebhookOwnerAccessService(dataSource).canReceive(
                        sub,
                        ORG_A,
                        'task.updated',
                        event,
                    )
                ).allowed;
            expect(await verdict(envelope)).toBe(true);
            // Without the envelope nothing of an organization goes to a user owner.
            expect(await verdict()).toBe(false);
            await dataSource
                .getRepository(Task)
                .update({ id: orgTask.id }, { visibility: 'private', visibilityExplicit: true });
            expect(await verdict(envelope)).toBe(false);
        });
    });

    it('ignores v1 subscriptions and paused v2 ones', async () => {
        await fanout.catchUp();
        await subscriptions.createForAccount({
            accountId: OWNER,
            url: 'https://v1.example.com',
            secretEncrypted: 's',
        });
        const paused = await subscribe();
        await subscriptions.pause(paused.id);
        await record();
        await dispatch();
        expect(await fanout.catchUp()).toBe(0);
        expect(await deliveries()).toEqual([]);
    });
});
