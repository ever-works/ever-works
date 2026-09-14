import { DataSource } from 'typeorm';
import { McpServerConnection } from '@src/entities/mcp-server-connection.entity';
import { ENTITIES } from '../_entities-inventory';
import { McpServerConnectionRepository } from './mcp-server-connection.repository';

/**
 * Connection health (AW-15) — the failure counter under CONCURRENT attempts,
 * against a real in-memory database rather than a mocked repository.
 *
 * A run listing tools, a tool call and a Settings test can all fail against
 * the same connection at once. Each failure has to count: a lost increment
 * would leave an unreachable connection reported as `degraded`. better-sqlite3
 * is what CI and the e2e stack run, so the compare-and-set has to hold here.
 */
describe('McpServerConnectionRepository.stampConnectionResult — concurrent failures (integration)', () => {
    let dataSource: DataSource;
    let repo: McpServerConnectionRepository;

    const USER = '11111111-1111-4111-8111-111111111111';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        // The owning user row is not what is under test.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        repo = new McpServerConnectionRepository(dataSource.getRepository(McpServerConnection));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(McpServerConnection).clear();
    });

    async function seed(): Promise<McpServerConnection> {
        return dataSource.getRepository(McpServerConnection).save(
            dataSource.getRepository(McpServerConnection).create({
                userId: USER,
                name: 'docs',
                url: 'https://mcp.example.com/mcp',
                transport: 'streamable-http',
                authHeaders: null,
                enabled: true,
                source: 'manual',
            }),
        );
    }

    async function read(id: string): Promise<McpServerConnection> {
        return dataSource.getRepository(McpServerConnection).findOneOrFail({ where: { id } });
    }

    it('counts every one of several simultaneous failures', async () => {
        const row = await seed();

        await Promise.all(
            Array.from({ length: 5 }, () =>
                repo.stampConnectionResult(row.id, {
                    ok: false,
                    error: 'Server unreachable (connection failed).',
                }),
            ),
        );

        const stored = await read(row.id);
        expect(stored.healthFailureCount).toBe(5);
        expect(stored.health).toBe('unreachable');
        expect(stored.lastErrorCode).toBe('unreachable');
    });

    it('three simultaneous failures on a fresh connection reach unreachable, not degraded', async () => {
        const row = await seed();

        await Promise.all(
            Array.from({ length: 3 }, () =>
                repo.stampConnectionResult(row.id, { ok: false, error: 'boom' }),
            ),
        );

        const stored = await read(row.id);
        expect(stored.healthFailureCount).toBe(3);
        expect(stored.health).toBe('unreachable');
    });

    it('a success still resets the counter, and later failures count from zero', async () => {
        const row = await seed();
        await repo.stampConnectionResult(row.id, { ok: false, error: 'boom' });
        await repo.stampConnectionResult(row.id, { ok: false, error: 'boom' });

        await repo.stampConnectionResult(row.id, { ok: true });
        expect((await read(row.id)).healthFailureCount).toBe(0);
        expect((await read(row.id)).health).toBe('healthy');

        await repo.stampConnectionResult(row.id, { ok: false, error: 'boom' });
        const stored = await read(row.id);
        expect(stored.healthFailureCount).toBe(1);
        expect(stored.health).toBe('degraded');
    });
});
