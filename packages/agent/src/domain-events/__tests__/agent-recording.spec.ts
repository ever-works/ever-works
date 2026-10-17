import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { AgentsService } from '../../agents/agents.service';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { AgentBudgetRepository } from '../../database/repositories/agent-budget.repository';
import { AgentMembershipRepository } from '../../database/repositories/agent-membership.repository';
import type { OwnershipScope } from '../../database/ownership-scope';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { AgentBudget } from '../../entities/agent-budget.entity';
import { AgentMembership } from '../../entities/agent-membership.entity';
import { DomainEvent } from '../../entities/domain-event.entity';
import { DomainEventPublisher } from '../domain-event-publisher.service';
import { DomainEventRecorder } from '../domain-event-recorder.service';
import {
    catalogDataValidator,
    createDomainEventsDataSource,
    ORG_A,
    resetDomainEventsTables,
    TENANT,
} from './domain-events.test-helpers';

/**
 * Agent recording points (EW-P1-1 B2, spec §3–4): the real `AgentsService` on
 * SQLite. Agent writes are multi-step, so each `agent.*` event is recorded in
 * its own transaction right after the write (best-effort); each event's
 * `data` is valid against the schema its catalog row names.
 */
describe('agent recording points', () => {
    let dataSource: DataSource;
    let agents: AgentsService;
    const expectValid = catalogDataValidator();
    const OWNER = randomUUID();
    const scope = { tenantId: TENANT, organizationId: ORG_A } as unknown as OwnershipScope;

    const events = async () =>
        dataSource.getRepository(DomainEvent).find({ order: { outboxSeq: 'ASC' } });

    beforeAll(async () => {
        dataSource = await createDomainEventsDataSource();
        const u = undefined;
        agents = new AgentsService(
            new AgentRepository(dataSource.getRepository(Agent)),
            new AgentMembershipRepository(dataSource.getRepository(AgentMembership)),
            new AgentBudgetRepository(dataSource.getRepository(AgentBudget)),
            u,
            u,
            u,
            u,
            u,
            u,
            u,
            new DomainEventPublisher(new DomainEventRecorder(), dataSource),
        );
    });

    beforeEach(async () => {
        await resetDomainEventsTables(dataSource);
        for (const table of ['agents', 'agent_memberships', 'agent_budgets']) {
            await dataSource.query(`DELETE FROM "${table}"`);
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const newAgent = (name = 'Release Captain') =>
        agents.create(OWNER, { name, scope: AgentScope.TENANT } as never, scope);

    it('create records agent.created at version 1 with a valid agent DTO', async () => {
        const agent = await newAgent();
        const [event] = await events();
        expect(event).toMatchObject({
            type: 'agent.created',
            aggregateType: 'agent',
            aggregateId: agent.id,
            aggregateVersion: 1,
            tenantId: TENANT,
            organizationId: ORG_A,
        });
        expect(event.data).toMatchObject({
            id: agent.id,
            name: 'Release Captain',
            status: 'draft',
            teamIds: [],
            visibility: 'organization',
        });
        expectValid(event);
    });

    it('update, transition and archive record agent.updated / status_changed / archived in order', async () => {
        const agent = await newAgent();
        await agents.update(OWNER, agent.id, { title: 'Ships releases' } as never, scope);
        await agents.transition(OWNER, agent.id, AgentStatus.ACTIVE, scope);
        await agents.archive(OWNER, agent.id, scope);
        const recorded = (await events()).filter((event) => event.type !== 'agent.created');
        expect(recorded.map((event) => [event.type, event.aggregateVersion])).toEqual([
            ['agent.updated', 2],
            ['agent.status_changed', 3],
            ['agent.archived', 4],
        ]);
        expect(recorded[0].changedFields).toContain('title');
        expect(recorded[1]).toMatchObject({ previous: { status: 'draft' } });
        expect(recorded[1].data).toMatchObject({ status: 'active' });
        expect(recorded[2].data).toMatchObject({ status: 'archived' });
        for (const event of recorded) expectValid(event);
    });

    it('a hard delete records an agent.deleted tombstone at a version claimed before the delete', async () => {
        const agent = await newAgent();
        await agents.deleteHard(OWNER, agent.id, scope);
        const deleted = (await events()).find((event) => event.type === 'agent.deleted');
        expect(deleted).toMatchObject({ aggregateId: agent.id, aggregateVersion: 2 });
        expect(deleted?.data).toMatchObject({ id: agent.id, deleted: true });
        expectValid(deleted!);
        expect(await dataSource.getRepository(Agent).findOneBy({ id: agent.id })).toBeNull();
    });
});
