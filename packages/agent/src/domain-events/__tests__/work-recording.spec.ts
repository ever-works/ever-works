import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { UserRepository } from '../../database/repositories/user.repository';
import { WorkMemberRepository } from '../../database/repositories/work-member.repository';
import { DomainEvent } from '../../entities/domain-event.entity';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { WorkCreatedEvent } from '../../events/work-created.event';
import { WorkStatusChangedEvent } from '../../events/work-status-changed.event';
import type { WorkOwnershipService } from '../../services/work-ownership.service';
import { WorkMemberService } from '../../services/work-member.service';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import { DomainEventWorkBridge } from '../domain-event-work-bridge';
import {
    catalogDataValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Work recording points (EW-P1-1 B2, spec §3–4): the `work.created` /
 * `work.status.changed` bridge and the real `WorkMemberService` on SQLite.
 * Work writes record after the write, in a transaction of their own
 * (best-effort, `recordAfterWrite`); each event's `data` is valid against
 * the schema its catalog row names.
 */
describe('work recording points', () => {
    let dataSource: DataSource;
    let bridge: DomainEventWorkBridge;
    let members: WorkMemberService;
    const expectValid = catalogDataValidator();
    const OWNER = randomUUID();
    const INVITEE = randomUUID();
    const WORK = randomUUID();

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });
    const workVersion = async () =>
        Number((await dataSource.getRepository(Work).findOneByOrFail({ id: WORK })).version);

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        const publisher = new DomainEventPublisher(new DomainEventRecorder(), dataSource);
        bridge = new DomainEventWorkBridge(publisher);
        // Authorization is the ownership service's job and not under test here.
        const ownership = {
            ensureCanManageMembers: async () => ({
                work: await dataSource.getRepository(Work).findOneByOrFail({ id: WORK }),
            }),
            ensureCanView: async () => ({ isCreator: false }),
        } as unknown as WorkOwnershipService;
        members = new WorkMemberService(
            new WorkMemberRepository(dataSource.getRepository(WorkMember)),
            new UserRepository(dataSource.getRepository(User)),
            ownership,
            publisher,
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of ['works', 'work_members', 'users']) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
        for (const [id, name] of [
            [OWNER, 'owner'],
            [INVITEE, 'invitee'],
        ]) {
            await dataSource.getRepository(User).insert({
                id,
                username: name,
                slug: `${name}-${id.slice(0, 6)}`,
                email: `${name}@example.com`,
                tenantId: TENANT,
            } as unknown as User);
        }
        await dataSource.getRepository(Work).insert({
            id: WORK,
            name: 'Awesome Lists',
            slug: 'awesome-lists',
            description: 'A directory',
            userId: OWNER,
            tenantId: TENANT,
            organizationId: ORG_A,
        } as unknown as Work);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const loadWork = () => dataSource.getRepository(Work).findOneByOrFail({ id: WORK });

    it('the work.created app event records work.created at version 1 with a valid work DTO', async () => {
        await bridge.onWorkCreated(new WorkCreatedEvent(await loadWork()));
        const [event] = await events();
        expect(event).toMatchObject({
            type: 'work.created',
            aggregateType: 'work',
            aggregateId: WORK,
            aggregateVersion: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
            actorType: 'user',
            actorId: OWNER,
        });
        expect(event.data).toMatchObject({
            id: WORK,
            name: 'Awesome Lists',
            members: [{ userId: OWNER, role: 'owner' }],
        });
        expectValid(event);
    });

    it('a Work created through an integration key records createdBy = the key; the owner stays the owner', async () => {
        const KEY = randomUUID();
        await dataSource
            .getRepository(Work)
            .update({ id: WORK }, { createdByType: 'integration', createdById: KEY } as never);
        await bridge.onWorkCreated(new WorkCreatedEvent(await loadWork()));
        const [event] = await events();
        expect(event.data).toMatchObject({
            createdBy: { type: 'integration', id: KEY },
            owner: { type: 'user', id: OWNER },
        });
        expectValid(event);
    });

    it('a Work the owner created says so (no stored author)', async () => {
        await bridge.onWorkCreated(new WorkCreatedEvent(await loadWork()));
        const [event] = await events();
        expect(event.data).toMatchObject({ createdBy: { type: 'user', id: OWNER } });
    });

    it('a status change records work.updated, and archiving records work.archived', async () => {
        const changed = (previous: string, next: string) =>
            new WorkStatusChangedEvent(
                WORK,
                OWNER,
                'default' as never,
                previous as never,
                next as never,
            );
        await bridge.onWorkStatusChanged(changed('active', 'paused'));
        await bridge.onWorkStatusChanged(changed('paused', 'archived'));
        const recorded = await events();
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['work.updated', 2],
            ['work.archived', 3],
        ]);
        expect(recorded[0]).toMatchObject({
            changedFields: ['status'],
            previous: { status: 'active' },
        });
        for (const event of recorded) expectValid(event);
        expect(await workVersion()).toBe(3);
    });

    it('roster changes record work.member.* child events that bump the work version', async () => {
        const { member } = await members.inviteMember(WORK, OWNER, {
            email: 'invitee@example.com',
            role: 'editor',
        } as never);
        await members.updateMemberRole(WORK, OWNER, member.id, { role: 'manager' } as never);
        await members.removeMember(WORK, OWNER, member.id);
        const roster = await events();
        expect(roster.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['work.member.added', 2],
            ['work.member.updated', 3],
            ['work.member.removed', 4],
        ]);
        expect(roster[0].data).toEqual({ workId: WORK, userId: INVITEE, role: 'editor' });
        expect(roster[1]).toMatchObject({ previous: { role: 'editor' } });
        expect(roster[2].data).toMatchObject({ userId: INVITEE, role: 'manager', deleted: true });
        for (const event of roster) {
            expect(event.changedFields).toEqual(['members']);
            expectValid(event);
        }
        expect(await workVersion()).toBe(4);
    });

    it('a recording failure never fails the write it describes', async () => {
        const failing = new DomainEventWorkBridge({
            transaction: async () => {
                throw new Error('outbox down');
            },
        } as unknown as DomainEventPublisher);
        await expect(
            failing.onWorkCreated(new WorkCreatedEvent(await loadWork())),
        ).resolves.toBeUndefined();
        expect(await events()).toEqual([]);
    });
});
