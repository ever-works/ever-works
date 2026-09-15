import { DataSource } from 'typeorm';
import { AgentRun } from '@src/entities/agent-run.entity';
import { ENTITIES } from '../_entities-inventory';
import { AgentRunRepository } from './agent-run.repository';

/**
 * Home (AW-19) — the Working now read rides the Sessions list query with two
 * additive options: `awaitingInput` and the `longest-running` order. Run
 * against better-sqlite3 (what CI and the e2e stack run) so the ordering and
 * the boolean predicate are the real SQL, not a mocked builder.
 */
describe('AgentRunRepository — working-now sessions read (integration)', () => {
    let dataSource: DataSource;
    let runs: AgentRunRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const OTHER_USER = '22222222-2222-4222-8222-222222222222';
    const ORG = '55555555-5555-4555-8555-555555555555';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00.000Z`);

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
        await dataSource.getRepository(AgentRun).clear();
    });

    function seedRun(overrides: Partial<AgentRun>): Promise<AgentRun> {
        const repository = dataSource.getRepository(AgentRun);
        return repository.save(
            repository.create({
                userId: USER,
                agentId: AGENT,
                triggerKind: 'task',
                status: 'running',
                gateAttempts: 0,
                persistent: false,
                awaitingInput: false,
                interruptRequested: false,
                startedAt: at('09:00'),
                createdAt: at('08:59'),
                ...overrides,
            } as Partial<AgentRun>),
        );
    }

    it('excludes a running run that waits on a human and counts only the rest', async () => {
        const acting = await seedRun({});
        await seedRun({ awaitingInput: true });
        await seedRun({ status: 'completed' });

        const [rows, total] = await runs.listSessionsForUser(USER, {
            status: 'running',
            awaitingInput: false,
        });

        expect(total).toBe(1);
        expect(rows.map((row) => row.id)).toEqual([acting.id]);
    });

    it('lists the longest-running first and pages without losing the total', async () => {
        const recent = await seedRun({ startedAt: at('10:30'), createdAt: at('10:29') });
        const oldest = await seedRun({ startedAt: at('06:00'), createdAt: at('11:00') });
        const middle = await seedRun({ startedAt: at('08:00'), createdAt: at('07:59') });

        const [rows, total] = await runs.listSessionsForUser(
            USER,
            { status: 'running', awaitingInput: false, order: 'longest-running' },
            2,
        );

        expect(total).toBe(3);
        expect(rows.map((row) => row.id)).toEqual([oldest.id, middle.id]);
        expect(rows.map((row) => row.id)).not.toContain(recent.id);
    });

    it('keeps the newest-first Sessions order when no order is asked for', async () => {
        const first = await seedRun({ createdAt: at('07:00') });
        const second = await seedRun({ createdAt: at('08:00') });

        const [rows] = await runs.listSessionsForUser(USER, { status: 'running' });

        expect(rows.map((row) => row.id)).toEqual([second.id, first.id]);
    });

    it('counts runs created inside a window, per scope, for the scoped spend line', async () => {
        await seedRun({ createdAt: at('08:00'), organizationId: ORG });
        await seedRun({ createdAt: at('09:00'), organizationId: ORG });
        await seedRun({ createdAt: at('10:00') });
        await seedRun({ createdAt: at('12:00'), organizationId: ORG });
        await seedRun({ createdAt: at('09:30'), userId: OTHER_USER, organizationId: ORG });

        const from = at('08:00');
        const to = at('12:00');

        await expect(runs.countCreatedForUserInWindow(USER, from, to)).resolves.toBe(3);
        await expect(
            runs.countCreatedForUserInWindow(USER, from, to, {
                tenantId: null,
                organizationId: ORG,
            }),
        ).resolves.toBe(2);
        await expect(
            runs.countCreatedForUserInWindow(USER, from, to, {
                tenantId: null,
                organizationId: null,
            }),
        ).resolves.toBe(1);
    });

    it('never reads another owner or another scope', async () => {
        await seedRun({ userId: OTHER_USER });
        await seedRun({ organizationId: ORG });
        const personal = await seedRun({});

        const [rows, total] = await runs.listSessionsForUser(
            USER,
            { status: 'running', awaitingInput: false, order: 'longest-running' },
            5,
            0,
            { tenantId: null, organizationId: null },
        );

        expect(total).toBe(1);
        expect(rows[0].id).toBe(personal.id);
    });
});
