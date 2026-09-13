import { DataSource, type ObjectLiteral } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { User } from '../../entities/user.entity';
import { Mission, MissionStatus, MissionType } from '../../entities/mission.entity';
import { Task } from '../../entities/task.entity';
import { Agent, AgentScope } from '../../entities/agent.entity';
import { Work } from '../../entities/work.entity';
import { WorkMember } from '../../entities/work-member.entity';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';
import { Skill } from '../../entities/skill.entity';
import { Team } from '../../entities/team.entity';
import { WorkKnowledgeDocument } from '../../entities/work-knowledge-document.entity';
import { KbDocumentClass, KbDocumentStatus } from '../../entities/kb-types';
import { WorkspaceSearchService } from '../workspace-search.service';
import type { WorkspaceSearchScope } from '../workspace-search.types';

/**
 * The palette's live fan-out runs on every database Ever Works deploys on.
 *
 * The demo stack, OSS self-hosts, local development and the e2e harness all
 * run better-sqlite3; production runs Postgres. A search path that used a
 * Postgres-only operator would 500 on every SQLite deployment, which is the
 * exact defect `work-proposal.search-portability.integration.spec.ts` guards
 * for the Ideas list. This spec executes every P1 source against a real
 * in-memory SQLite database with LIKE forced case-SENSITIVE, captures every
 * emitted statement, and also pins the workspace-scope boundaries.
 */
describe('WorkspaceSearchService — live fan-out on SQLite (integration)', () => {
    const TENANT = '11111111-1111-4111-8111-111111111111';
    const ORG_A = '22222222-2222-4222-8222-222222222222';
    const ORG_B = '33333333-3333-4333-8333-333333333333';

    let dataSource: DataSource;
    let service: WorkspaceSearchService;
    let captured: string[];
    let ownerId: string;
    let otherId: string;

    const scopeA = (): WorkspaceSearchScope => ({
        userId: ownerId,
        tenantId: TENANT,
        organizationId: ORG_A,
    });

    async function save<T extends ObjectLiteral>(
        entity: new () => T,
        values: Record<string, unknown>,
    ): Promise<T> {
        const repo = dataSource.getRepository(entity);
        const entityRow = repo.create(values as never) as unknown as T;
        return (await repo.save(entityRow)) as T;
    }

    beforeAll(async () => {
        captured = [];
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: ['query'],
            logger: {
                logQuery: (query: string) => captured.push(query),
                logQueryError: () => undefined,
                logQuerySlow: () => undefined,
                logSchemaBuild: () => undefined,
                logMigration: () => undefined,
                log: () => undefined,
            },
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA case_sensitive_like = ON');
        service = new WorkspaceSearchService(dataSource);

        ownerId = (
            await save(User, { username: 'owner', email: 'owner@example.com', password: 'x' })
        ).id;
        otherId = (
            await save(User, { username: 'other', email: 'other@example.com', password: 'x' })
        ).id;

        const inScope = (userId: string, organizationId: string | null = ORG_A) => ({
            userId,
            tenantId: TENANT,
            organizationId,
        });
        const mission = (title: string, scope: Record<string, unknown>) =>
            save(Mission, {
                ...scope,
                title,
                description: 'Mission seed',
                type: MissionType.ONE_SHOT,
                status: MissionStatus.ACTIVE,
            });

        await mission('Invoice Reconciliation', inScope(ownerId));
        await mission('Supplier intake', inScope(ownerId));
        await mission('100% Invoice coverage', inScope(ownerId));
        await mission('Invoice only in Organization B', inScope(ownerId, ORG_B));
        await mission('Invoice in personal scope', inScope(ownerId, null));
        await mission('Invoice owned by someone else', inScope(otherId));

        await save(Task, {
            ...inScope(ownerId),
            slug: 'T-418',
            title: 'Draft the Invoice follow-up',
            description: 'Chase the payment',
            labels: ['billing'],
            createdByType: 'user',
            createdById: ownerId,
        });
        await save(Agent, {
            ...inScope(ownerId),
            scope: AgentScope.TENANT,
            name: 'Ivy',
            slug: 'ivy',
            title: 'Invoice clerk',
            permissions: {},
        });

        const ownWork = await save(Work, {
            ...inScope(ownerId),
            name: 'Acme Invoice Directory',
            slug: 'acme-invoice-directory',
            description: 'Directory of invoice tools',
        });
        const sharedWork = await save(Work, {
            ...inScope(otherId),
            name: 'Shared Invoice Library',
            slug: 'shared-invoice-library',
            description: 'Shared with the owner',
        });
        const privateWork = await save(Work, {
            ...inScope(otherId),
            name: 'Private ledger',
            slug: 'private-ledger',
            description: 'Not shared',
        });
        await save(WorkMember, { workId: sharedWork.id, userId: ownerId });

        await save(WorkProposal, {
            ...inScope(ownerId),
            title: 'Invoice portal',
            description: 'An idea',
            slugSuggestion: 'invoice-portal',
            suggestedCategories: [],
            suggestedFields: [],
            recommendedPlugins: [],
            generatedPrompt: 'prompt',
            reasoning: 'seed',
            source: WorkProposalSource.USER_MANUAL,
            status: WorkProposalStatus.PENDING,
        });
        await save(Skill, {
            ...inScope(ownerId),
            ownerType: 'tenant',
            ownerId,
            slug: 'invoice-triage',
            title: 'Invoice triage',
            description: 'Sort incoming invoices',
            frontmatter: { name: 'invoice-triage', description: 'Sort incoming invoices' },
            instructionsMd: '# Triage',
            contentHash: 'hash',
        });
        await save(Team, { ...inScope(otherId), name: 'Invoice crew', slug: 'invoice-crew' });
        await save(Team, {
            ...inScope(otherId, ORG_B),
            name: 'Invoice crew elsewhere',
            slug: 'invoice-crew',
        });

        const doc = (workId: string, path: string, title: string) =>
            save(WorkKnowledgeDocument, {
                workId,
                path,
                slug: path.replace(/\W+/g, '-'),
                title,
                kbDocumentClass: KbDocumentClass.FREEFORM,
                status: KbDocumentStatus.ACTIVE,
            });
        await doc(ownWork.id, 'legal/invoice-policy.md', 'Invoice policy');
        await doc(sharedWork.id, 'glossary/billing.md', 'Invoice glossary');
        await doc(privateWork.id, 'secret/invoice.md', 'Invoice secret');
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(() => {
        captured.length = 0;
    });

    const titlesByKind = async (query: string, scope = scopeA(), perKindLimit = 25) => {
        const response = await service.search(scope, { query, perKindLimit });
        return {
            response,
            byKind: Object.fromEntries(
                response.groups.map((g) => [g.kind, g.hits.map((h) => h.title)]),
            ),
        };
    };

    it('CONTROL: LIKE is case-sensitive in this database', async () => {
        const [row] = (await dataSource.query(
            `SELECT ('Invoice' LIKE '%invoice%') AS hit`,
        )) as Array<{
            hit: number;
        }>;
        expect(row.hit).toBe(0);
    });

    it('returns a row for every P1 kind, case-insensitively, with no degraded source', async () => {
        const { response, byKind } = await titlesByKind('INVOICE');
        expect(response.degradedKinds).toEqual([]);
        expect(Object.keys(byKind).sort()).toEqual(
            ['agent', 'idea', 'knowledge', 'mission', 'skill', 'task', 'team', 'work'].sort(),
        );
        expect(byKind.mission).toEqual(expect.arrayContaining(['Invoice Reconciliation']));
        expect(byKind.task).toEqual(['Draft the Invoice follow-up']);
        expect(byKind.agent).toEqual(['Ivy']);
        expect(byKind.idea).toEqual(['Invoice portal']);
        expect(byKind.skill).toEqual(['Invoice triage']);
    });

    it('matches identifiers and label lists', async () => {
        const bySlug = await titlesByKind('t-418');
        expect(bySlug.byKind.task).toEqual(['Draft the Invoice follow-up']);
        expect(bySlug.response.groups[0].hits[0].score).toBe(100);

        const byLabel = await titlesByKind('billing');
        expect(byLabel.byKind.task).toEqual(['Draft the Invoice follow-up']);
    });

    it('treats % in the query as a literal percent sign', async () => {
        const { byKind } = await titlesByKind('100%');
        expect(byKind.mission).toEqual(['100% Invoice coverage']);
    });

    it('finds an in-order subsequence (fuzzy) match through portable LIKE', async () => {
        const { byKind, response } = await titlesByKind('ivrc');
        expect(byKind.mission).toEqual(['Invoice Reconciliation']);
        expect(response.groups[0].hits[0].matchReason).toBe('fuzzy');
    });

    it('never emits a database-specific matching operator', async () => {
        await titlesByKind('invoice');
        expect(captured.length).toBeGreaterThan(0);
        const matching = captured.join('\n');
        expect(matching).not.toMatch(/\bILIKE\b/i);
        expect(matching).not.toMatch(/to_tsvector|websearch_to_tsquery|plainto_tsquery/i);
        expect(matching).not.toContain('~*');
        expect(matching).toMatch(/LOWER\(.+\) LIKE \? ESCAPE/);
    });

    describe('workspace scope and access', () => {
        it('never returns a record from another Organization', async () => {
            const { byKind } = await titlesByKind('Organization B');
            expect(byKind.mission).toBeUndefined();

            const inB = await titlesByKind('Organization B', {
                userId: ownerId,
                tenantId: TENANT,
                organizationId: ORG_B,
            });
            expect(inB.byKind.mission).toEqual(['Invoice only in Organization B']);
        });

        it('returns personal-scope records only while no Organization is active', async () => {
            expect((await titlesByKind('personal scope')).byKind.mission).toBeUndefined();
            const personal = await titlesByKind('invoice', {
                userId: ownerId,
                tenantId: TENANT,
                organizationId: null,
            });
            expect(personal.byKind.mission).toEqual(['Invoice in personal scope']);
        });

        it("never returns another user's Mission", async () => {
            const { byKind } = await titlesByKind('someone else');
            expect(byKind.mission).toBeUndefined();
        });

        it('returns Works the caller created or is a member of, and no others', async () => {
            const { byKind } = await titlesByKind('invoice');
            expect([...byKind.work].sort()).toEqual([
                'Acme Invoice Directory',
                'Shared Invoice Library',
            ]);
            expect((await titlesByKind('private ledger')).byKind.work).toBeUndefined();
        });

        it('returns Knowledge only for Works the caller created or is a member of', async () => {
            const { byKind, response } = await titlesByKind('invoice');
            expect([...byKind.knowledge].sort()).toEqual(['Invoice glossary', 'Invoice policy']);
            const policy = response.groups
                .find((g) => g.kind === 'knowledge')
                ?.hits.find((h) => h.title === 'Invoice policy');
            expect(policy?.destination).toMatch(/^\/works\/[^/]+\/kb\/legal\/invoice-policy\.md$/);
        });

        it('returns Organization Teams to any caller in that Organization, and only that one', async () => {
            const { byKind } = await titlesByKind('crew');
            expect(byKind.team).toEqual(['Invoice crew']);
        });
    });
});
