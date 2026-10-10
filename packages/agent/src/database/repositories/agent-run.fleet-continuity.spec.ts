import { DataSource } from 'typeorm';
import { AgentRun } from '@src/entities/agent-run.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunRepository } from './agent-run.repository';

/**
 * Self-build slice AU — the run-row writes behind fleet run continuity,
 * pinned against a real database (the `simple-json` column round-trip and
 * the conditional `LIKE` are claims about SQL, not about a mock):
 *
 *   - `recordFleetCliSession` writes the session id AND the node record in
 *     one statement, and `null` retires only the node record;
 *   - `seedResumeContext` carries the node record onto a successor;
 *   - `recordDispatchRunner` tags a fleet dispatch, and a cloud dispatch
 *     clears ONLY a fleet tag — never a value a cloud pipeline wrote.
 */
describe('AgentRunRepository — fleet run continuity (slice AU)', () => {
    let dataSource: DataSource;
    let runs: AgentRunRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const RUN = '22222222-2222-4222-8222-222222222222';
    const SESSION = {
        sessionId: '3f0e9a52-7b1c-4d2e-9a8f-0c1d2e3f4a5b',
        nodeId: '44444444-4444-4444-8444-444444444444',
        provider: 'claude-code' as const,
    };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        runs = new AgentRunRepository(dataSource.getRepository(AgentRun));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        const repo = dataSource.getRepository(AgentRun);
        await repo.clear();
        await repo.save(
            repo.create({
                id: RUN,
                userId: USER,
                agentId: AGENT,
                triggerKind: 'task',
                status: 'completed',
            }),
        );
    });

    const reload = async () => (await runs.findById(RUN))!;

    it('records the session id and the node that holds it together, and retires only the node record', async () => {
        await runs.recordFleetCliSession(RUN, SESSION);
        let row = await reload();
        expect(row.cliSessionId).toBe(SESSION.sessionId);
        expect(row.fleetCliSession).toEqual(SESSION);

        await runs.recordFleetCliSession(RUN, null);
        row = await reload();
        expect(row.fleetCliSession).toBeNull();
        // The resume key is left to its other writers.
        expect(row.cliSessionId).toBe(SESSION.sessionId);
    });

    it('seeds a successor with the carried node record', async () => {
        await runs.seedResumeContext(RUN, {
            cliSessionId: SESSION.sessionId,
            pendingInput: ['use Postgres'],
            fleetCliSession: SESSION,
        });
        const row = await reload();
        expect(row.fleetCliSession).toEqual(SESSION);
        expect(row.pendingInput).toEqual(['use Postgres']);
    });

    it('tags a fleet dispatch, and a cloud dispatch clears only a fleet tag', async () => {
        await runs.recordDispatchRunner(RUN, 'fleet-node:claude-code');
        expect((await reload()).runnerKind).toBe('fleet-node:claude-code');

        await runs.recordDispatchRunner(RUN, null);
        expect((await reload()).runnerKind).toBeNull();

        // A value a cloud pipeline wrote is never touched by the clear.
        await dataSource.getRepository(AgentRun).update(RUN, { runnerKind: 'claude-code' });
        await runs.recordDispatchRunner(RUN, null);
        expect((await reload()).runnerKind).toBe('claude-code');
    });
});
