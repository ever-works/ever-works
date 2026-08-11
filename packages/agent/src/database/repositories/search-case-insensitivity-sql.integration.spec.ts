import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { User } from '../../entities/user.entity';
import { Agent, AgentScope, AgentStatus } from '../../entities/agent.entity';
import { Task, TaskStatus } from '../../entities/task.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KbDocumentClass, KbDocumentStatus } from '../../entities/kb-types';
import { AgentRepository } from './agent.repository';
import { TaskRepository } from './task.repository';
import { WorkKnowledgeDocumentRepository } from './work-knowledge-document.repository';

/**
 * Guard for the three search surfaces that matched case-SENSITIVELY on
 * Postgres — i.e. in stage and production — while looking perfectly
 * healthy in CI.
 *
 * SQLite's `LIKE` is case-insensitive for ASCII by default. PostgreSQL's
 * is not. Three repositories built a bare `col LIKE :q` against a
 * non-lowered column and paired it with a non-lowered pattern:
 *
 *     agent.repository.ts                    — GET /api/me/agents?search=
 *     task.repository.ts                     — GET /api/me/tasks?search= and ?label=
 *     work-knowledge-document.repository.ts  — KB document search (Work + Org scope)
 *
 * On Postgres, searching Agents for `deploy` therefore did NOT match an
 * Agent named `Deploy Bot`. No error, no log line — just silently fewer
 * results, the same "looks like empty data, not like a failure" signature
 * as the `getPeriodTotals` unquoted-column bug.
 *
 * Why CI could never catch it: `config/index.ts` defaults `DATABASE_TYPE`
 * to `better-sqlite3`, so unit specs AND the Playwright e2e stack both run
 * SQLite. A behavioural assertion on SQLite passes for the WRONG reason —
 * the driver is case-insensitive, so the defective query returns the right
 * answer there and only there.
 *
 * This spec closes that hole two independent ways:
 *
 *  1. `PRAGMA case_sensitive_like = ON` makes SQLite's `LIKE` behave
 *     exactly like Postgres's, so the behavioural assertions below really
 *     do execute the production semantics. The first test is a control
 *     that proves the pragma took effect — without it, every "found the
 *     mixed-case row" assertion would be a false clean.
 *  2. Assertions on the emitted SQL text, which is driver-independent:
 *     every searched column must be wrapped in `LOWER(...)` AND the bound
 *     pattern must itself be lower-cased. Lowering only one side is still
 *     case-sensitive.
 *
 * Reverting any of the three repositories to a bare `LIKE` fails this spec.
 */
describe('search predicates are case-insensitive on Postgres semantics (integration)', () => {
    let dataSource: DataSource;
    let captured: Array<{ query: string; parameters?: unknown[] }>;

    let users: Repository<User>;
    let agents: Repository<Agent>;
    let tasks: Repository<Task>;
    let kbDocs: Repository<WorkKnowledgeDocument>;

    let agentRepository: AgentRepository;
    let taskRepository: TaskRepository;
    let kbRepository: WorkKnowledgeDocumentRepository;

    let userId: string;

    const ORG_ID = '33333333-3333-4333-8333-333333333333';

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

        // The whole point of this spec: make SQLite's LIKE case-SENSITIVE so
        // it matches PostgreSQL. Without this the defective queries below
        // return the correct rows and nothing can fail.
        await dataSource.query('PRAGMA case_sensitive_like = ON');

        users = dataSource.getRepository(User);
        agents = dataSource.getRepository(Agent);
        tasks = dataSource.getRepository(Task);
        kbDocs = dataSource.getRepository(WorkKnowledgeDocument);

        agentRepository = new AgentRepository(agents);
        taskRepository = new TaskRepository(tasks);
        kbRepository = new WorkKnowledgeDocumentRepository(kbDocs);

        const user = await users.save(
            users.create({
                username: 'searcher',
                email: 'searcher@example.com',
                password: 'x',
            } as Partial<User>),
        );
        userId = user.id;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(() => {
        captured.length = 0;
    });

    // ── helpers ──────────────────────────────────────────────────────────

    const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /** The statement that actually carries the user's search predicate. */
    const searchStatement = (table: string) => {
        const entry = captured.find((c) => c.query.includes(table) && / LIKE /i.test(c.query));
        expect(entry).toBeDefined();
        return entry!;
    };

    /**
     * The decisive, driver-independent assertion. A column is only matched
     * case-insensitively when BOTH sides are folded: `LOWER(col) LIKE
     * '%lowered%'`. This checks the column half; `expectLoweredPattern`
     * checks the parameter half.
     */
    const expectLoweredLike = (sql: string, alias: string, column: string) => {
        const quoted = `"${alias}"."${column}"`;

        // Control: the statement really does reference this column, so a
        // passing test below cannot be one that simply matched nothing.
        expect(sql).toContain(quoted);

        expect(sql).toContain(`LOWER(${quoted}) LIKE`);
        // The defect: a LIKE applied straight to the un-folded column.
        expect(sql).not.toMatch(new RegExp(`(?<!LOWER\\()${escapeRe(quoted)}\\s+LIKE`, 'i'));
    };

    const expectLoweredPattern = (parameters: unknown[] | undefined, expected: string) => {
        expect(parameters).toBeDefined();
        expect(parameters).toContain(expected);
    };

    // ── control ──────────────────────────────────────────────────────────

    it('CONTROL: the pragma is in effect, so a bare LIKE is case-sensitive here', async () => {
        const [bare] = (await dataSource.query(
            `SELECT ('Deploy Bot' LIKE '%deploy%') AS hit`,
        )) as Array<{ hit: number }>;
        // 0 → this connection now behaves like Postgres. If this ever reads 1
        // the pragma silently failed and every assertion below is worthless.
        expect(bare.hit).toBe(0);

        const [folded] = (await dataSource.query(
            `SELECT (LOWER('Deploy Bot') LIKE '%deploy%') AS hit`,
        )) as Array<{ hit: number }>;
        expect(folded.hit).toBe(1);
    });

    // ── agents ───────────────────────────────────────────────────────────

    describe('AgentRepository.findByUserIdScoped', () => {
        beforeAll(async () => {
            await agents.save(
                agents.create({
                    userId,
                    scope: AgentScope.TENANT,
                    name: 'Deploy Bot',
                    slug: 'Deploy-Bot',
                    title: 'Release Captain',
                    status: AgentStatus.ACTIVE,
                    permissions: {},
                } as Partial<Agent>),
            );
        });

        it('finds a mixed-case name from a lower-case query', async () => {
            const { rows } = await agentRepository.findByUserIdScoped(userId, {
                search: 'deploy',
            });
            expect(rows.map((r) => r.name)).toContain('Deploy Bot');
        });

        it('finds a lower-case query term from a mixed-case query', async () => {
            const { rows } = await agentRepository.findByUserIdScoped(userId, {
                search: 'RELEASE captain',
            });
            expect(rows.map((r) => r.name)).toContain('Deploy Bot');
        });

        it('emits LOWER() on every searched column and a lower-cased pattern', async () => {
            await agentRepository.findByUserIdScoped(userId, { search: 'DePloy' });

            const { query, parameters } = searchStatement('agents');
            expectLoweredLike(query, 'agent', 'name');
            expectLoweredLike(query, 'agent', 'slug');
            expectLoweredLike(query, 'agent', 'title');
            expectLoweredPattern(parameters, '%deploy%');
        });
    });

    // ── tasks ────────────────────────────────────────────────────────────

    describe('TaskRepository.findByUserIdFiltered', () => {
        beforeAll(async () => {
            await tasks.save(
                tasks.create({
                    userId,
                    slug: 'T-1',
                    title: 'Ship The Release',
                    description: 'Cut A Tag',
                    status: TaskStatus.BACKLOG,
                    labels: ['Bug', 'Ops'],
                    createdByType: 'user',
                    createdById: userId,
                } as Partial<Task>),
            );
        });

        it('finds a mixed-case title from a lower-case query', async () => {
            const { rows } = await taskRepository.findByUserIdFiltered(userId, {
                search: 'ship the release',
            });
            expect(rows.map((r) => r.slug)).toContain('T-1');
        });

        it('finds a mixed-case label from a lower-case ?label filter', async () => {
            const { rows } = await taskRepository.findByUserIdFiltered(userId, { label: 'bug' });
            expect(rows.map((r) => r.slug)).toContain('T-1');
        });

        it('still scopes the label filter to a whole JSON token', async () => {
            // `"bu"` must not match the stored `"Bug"` — case folding must not
            // widen the quoted-token boundary into a substring match.
            const { rows } = await taskRepository.findByUserIdFiltered(userId, { label: 'bu' });
            expect(rows).toHaveLength(0);
        });

        it('emits LOWER() on every searched column and a lower-cased pattern', async () => {
            await taskRepository.findByUserIdFiltered(userId, { search: 'Ship' });

            const { query, parameters } = searchStatement('tasks');
            expectLoweredLike(query, 'task', 'title');
            expectLoweredLike(query, 'task', 'slug');
            expectLoweredLike(query, 'task', 'description');
            expectLoweredPattern(parameters, '%ship%');
        });

        it('emits LOWER() on the labels column and a lower-cased token pattern', async () => {
            await taskRepository.findByUserIdFiltered(userId, { label: 'Bug' });

            const { query, parameters } = searchStatement('tasks');
            expectLoweredLike(query, 'task', 'labels');
            expectLoweredPattern(parameters, '%"bug"%');
        });
    });

    // ── knowledge-base documents ─────────────────────────────────────────

    describe('WorkKnowledgeDocumentRepository search', () => {
        beforeAll(async () => {
            await kbDocs.save(
                kbDocs.create({
                    organizationId: ORG_ID,
                    workId: null,
                    path: 'brand/Voice.md',
                    slug: 'voice',
                    title: 'Brand Voice Guide',
                    description: 'How We Write',
                    kbDocumentClass: KbDocumentClass.STYLE,
                    status: KbDocumentStatus.ACTIVE,
                    metadata: { body: 'Prefer Plain English.' },
                } as Partial<WorkKnowledgeDocument>),
            );
        });

        it('finds a mixed-case title from a lower-case query', async () => {
            const { items } = await kbRepository.list({ organizationId: ORG_ID, q: 'brand voice' });
            expect(items.map((d) => d.slug)).toContain('voice');
        });

        it('finds a mixed-case body from a lower-case query when searchBody is on', async () => {
            const { items } = await kbRepository.list({
                organizationId: ORG_ID,
                q: 'plain english',
                searchBody: true,
            });
            expect(items.map((d) => d.slug)).toContain('voice');
        });

        it('finds a mixed-case title through the org-aggregate feed', async () => {
            const { items } = await kbRepository.listForOrgAggregate({
                organizationId: ORG_ID,
                q: 'brand voice',
            });
            expect(items.map((d) => d.slug)).toContain('voice');
        });

        it('emits LOWER() on title/description and a lower-cased pattern (list)', async () => {
            await kbRepository.list({ organizationId: ORG_ID, q: 'Brand' });

            const { query, parameters } = searchStatement('work_knowledge_documents');
            expectLoweredLike(query, 'doc', 'title');
            expectLoweredLike(query, 'doc', 'description');
            expectLoweredPattern(parameters, '%brand%');
        });

        it('emits LOWER() on the metadata column too when searchBody is on', async () => {
            await kbRepository.list({ organizationId: ORG_ID, q: 'Plain', searchBody: true });

            const { query, parameters } = searchStatement('work_knowledge_documents');
            expectLoweredLike(query, 'doc', 'metadata');
            expectLoweredPattern(parameters, '%plain%');
        });

        it('emits LOWER() on title/description in the org-aggregate scope', async () => {
            await kbRepository.listForOrgAggregate({ organizationId: ORG_ID, q: 'Brand' });

            const { query, parameters } = searchStatement('work_knowledge_documents');
            expectLoweredLike(query, 'doc', 'title');
            expectLoweredLike(query, 'doc', 'description');
            expectLoweredPattern(parameters, '%brand%');
        });
    });

    // ── the escaping contract the previous code already got right ────────

    it('still escapes LIKE metacharacters so `%` cannot bypass the filter', async () => {
        const { rows } = await agentRepository.findByUserIdScoped(userId, { search: '%' });
        // A literal `%` matches no agent name; an unescaped one would match all.
        expect(rows).toHaveLength(0);

        const { query } = searchStatement('agents');
        expect(query).toMatch(/ESCAPE/i);
    });
});
