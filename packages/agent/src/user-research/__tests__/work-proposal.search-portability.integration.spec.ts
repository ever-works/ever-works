import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { User } from '../../entities/user.entity';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';
import { WorkProposalRepository } from '../work-proposal.repository';

/**
 * Guard for the Ideas search path — the ONE search surface in the monorepo
 * that used PostgreSQL's `ILIKE` with no driver guard.
 *
 *     GET /api/me/work-proposals?search=<term>
 *
 * `ILIKE` does not exist in SQLite, so the query threw and the endpoint
 * returned a raw 500 on every SQLite-backed deployment — the demo stack,
 * OSS self-hosts, and local dev. The /ideas page rendered its
 * "Could not load Ideas." alert instead of results.
 *
 * The e2e suite did not fail on this; it ENCODED the breakage as the
 * contract, asserting `expect([200, 500]).toContain(res.status())`. A test
 * that accepts a 500 cannot fail when the 500 spreads, so those assertions
 * are tightened to 200 alongside this fix.
 *
 * Secondary defect fixed at the same time: this was also the only search
 * path that skipped `sanitizeLikePattern`, so `?search=%` matched every
 * row instead of matching a literal percent sign.
 *
 * Routing the clause through `buildCaseInsensitiveLikeClause` fixes both
 * the portability defect and the case-sensitivity defect with one
 * mechanism: `LOWER(col) LIKE :p ESCAPE '\'` runs on Postgres, MySQL and
 * SQLite and is case-insensitive on all three.
 */
describe('WorkProposalRepository.findByUser — search runs on SQLite too (integration)', () => {
    let dataSource: DataSource;
    let captured: Array<{ query: string; parameters?: unknown[] }>;

    let users: Repository<User>;
    let proposals: Repository<WorkProposal>;
    let repository: WorkProposalRepository;

    let userId: string;

    beforeAll(async () => {
        captured = [];

        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: ['query'],
            logger: {
                logQuery: (query: string, parameters?: unknown[]) =>
                    captured.push({ query, parameters }),
                logQueryError: () => undefined,
                logQuerySlow: () => undefined,
                logSchemaBuild: () => undefined,
                logMigration: () => undefined,
                log: () => undefined,
            },
        });

        await dataSource.initialize();

        // Same trick as `search-case-insensitivity-sql.integration.spec.ts`:
        // make SQLite's LIKE case-SENSITIVE so the case-insensitivity
        // assertions below execute PostgreSQL's semantics rather than
        // SQLite's forgiving default.
        await dataSource.query('PRAGMA case_sensitive_like = ON');

        users = dataSource.getRepository(User);
        proposals = dataSource.getRepository(WorkProposal);
        repository = new WorkProposalRepository(proposals);

        const user = await users.save(
            users.create({
                username: 'ideator',
                email: 'ideator@example.com',
                password: 'x',
            } as Partial<User>),
        );
        userId = user.id;

        const seed = (title: string, description: string) =>
            proposals.save(
                proposals.create({
                    userId,
                    title,
                    description,
                    slugSuggestion: title.toLowerCase().replace(/\s+/g, '-'),
                    suggestedCategories: [],
                    suggestedFields: [],
                    recommendedPlugins: [],
                    generatedPrompt: description,
                    reasoning: 'seed',
                    source: WorkProposalSource.USER_MANUAL,
                    status: WorkProposalStatus.PENDING,
                } as Partial<WorkProposal>),
            );

        await seed('Deploy Bot Directory', 'A Curated List Of Release Tooling.');
        await seed('Unrelated Idea', 'Nothing To See Here.');
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(() => {
        captured.length = 0;
    });

    it('CONTROL: the pragma is in effect, so a bare LIKE is case-sensitive here', async () => {
        const [bare] = (await dataSource.query(
            `SELECT ('Deploy Bot' LIKE '%deploy%') AS hit`,
        )) as Array<{ hit: number }>;
        expect(bare.hit).toBe(0);
    });

    it('executes a search instead of throwing (no ILIKE anywhere in the SQL)', async () => {
        const rows = await repository.findByUser(userId, [WorkProposalStatus.PENDING], {
            search: 'deploy',
        });

        expect(rows.map((r) => r.title)).toEqual(['Deploy Bot Directory']);

        const statement = captured.find((c) => c.query.includes('work_proposals'));
        expect(statement).toBeDefined();
        // Control: this really is the search statement.
        expect(statement!.query).toMatch(/ LIKE /i);
        expect(statement!.query).not.toMatch(/ILIKE/i);
    });

    it('matches a mixed-case description from a lower-case term', async () => {
        const rows = await repository.findByUser(userId, [WorkProposalStatus.PENDING], {
            search: 'release tooling',
        });
        expect(rows.map((r) => r.title)).toEqual(['Deploy Bot Directory']);
    });

    it('lowers both the column and the bound pattern', async () => {
        await repository.findByUser(userId, [WorkProposalStatus.PENDING], { search: 'DePloy' });

        const statement = captured.find(
            (c) => c.query.includes('work_proposals') && / LIKE /i.test(c.query),
        );
        expect(statement).toBeDefined();
        expect(statement!.query).toContain('LOWER("p"."title") LIKE');
        expect(statement!.query).toContain('LOWER("p"."description") LIKE');
        expect(statement!.parameters).toContain('%deploy%');
    });

    it('escapes LIKE metacharacters so `?search=%` cannot match every row', async () => {
        const rows = await repository.findByUser(userId, [WorkProposalStatus.PENDING], {
            search: '%',
        });
        // A literal percent sign appears in neither seeded Idea.
        expect(rows).toHaveLength(0);
    });

    it('still treats a whitespace-only search as a no-op (unfiltered own set)', async () => {
        const rows = await repository.findByUser(userId, [WorkProposalStatus.PENDING], {
            search: '   ',
        });
        expect(rows).toHaveLength(2);
    });
});
