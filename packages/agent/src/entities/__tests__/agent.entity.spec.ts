import { getMetadataArgsStorage } from 'typeorm';
import {
    Agent,
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
    AGENT_PERMISSIONS_DEFAULT,
} from '../agent.entity';

/**
 * Shape tests for the `Agent` entity. We do NOT spin up a DataSource —
 * these tests just assert the TypeORM metadata graph is what
 * agents/plan.md §3.1 + agents/spec.md §5.10a (H3 override) prescribe.
 *
 * Tests are NOT run during /loop ticks; the operator will run the full
 * suite later with `pnpm test`.
 */
describe('Agent entity', () => {
    const storage = getMetadataArgsStorage();
    const table = storage.tables.find((t) => t.target === Agent);
    const columns = storage.columns.filter((c) => c.target === Agent);
    const indices = storage.indices.filter((i) => i.target === Agent);
    const columnNames = columns.map((c) => c.propertyName);

    it('maps to the `agents` table', () => {
        expect(table?.name).toBe('agents');
    });

    it('declares the required identity columns', () => {
        expect(columnNames).toEqual(
            expect.arrayContaining(['id', 'userId', 'scope', 'name', 'slug']),
        );
    });

    it('declares scope-specific FK columns (nullable)', () => {
        for (const col of ['missionId', 'ideaId', 'workId']) {
            const c = columns.find((cc) => cc.propertyName === col);
            expect(c).toBeDefined();
            expect(c?.options.nullable).toBe(true);
        }
    });

    it('declares all three avatar columns (H3 override — round 8)', () => {
        expect(columnNames).toEqual(
            expect.arrayContaining(['avatarMode', 'avatarIcon', 'avatarImageUploadId']),
        );
        const mode = columns.find((c) => c.propertyName === 'avatarMode');
        expect(mode?.options.default).toBe(AgentAvatarMode.INITIALS);
    });

    it('declares DB-inline file storage columns (tenant scope per ADR-008)', () => {
        expect(columnNames).toEqual(
            expect.arrayContaining([
                'soulMd',
                'agentsMd',
                'heartbeatMd',
                'toolsMd',
                'agentYml',
                'contentHash',
            ]),
        );
    });

    it('declares heartbeat fields', () => {
        expect(columnNames).toEqual(
            expect.arrayContaining([
                'heartbeatCadence',
                'idleBehavior',
                'nextHeartbeatAt',
                'lastRunAt',
                'lastRunStatus',
                'errorCount',
                'pauseAfterFailures',
            ]),
        );
        const idle = columns.find((c) => c.propertyName === 'idleBehavior');
        expect(idle?.options.default).toBe(AgentIdleBehavior.PROPOSE);
        const errCount = columns.find((c) => c.propertyName === 'errorCount');
        expect(errCount?.options.default).toBe(0);
        const pauseAfter = columns.find((c) => c.propertyName === 'pauseAfterFailures');
        expect(pauseAfter?.options.default).toBe(3);
    });

    it('declares the composite uniqueness on (userId, scope, missionId, ideaId, workId, slug)', () => {
        const uq = indices.find((i) => i.name === 'uq_agents_user_scope_slug');
        expect(uq).toBeDefined();
        expect(uq?.unique).toBe(true);
        expect(uq?.columns).toEqual(['userId', 'scope', 'missionId', 'ideaId', 'workId', 'slug']);
    });

    it('declares the dispatcher-hot-path index on (status, nextHeartbeatAt)', () => {
        const idx = indices.find((i) => i.name === 'idx_agents_next_heartbeat');
        expect(idx).toBeDefined();
        expect(idx?.columns).toEqual(['status', 'nextHeartbeatAt']);
    });

    it('declares per-scope lookup indexes', () => {
        expect(indices.some((i) => i.name === 'idx_agents_mission')).toBe(true);
        expect(indices.some((i) => i.name === 'idx_agents_work')).toBe(true);
        expect(indices.some((i) => i.name === 'idx_agents_idea')).toBe(true);
    });

    it('exposes the AgentScope enum values', () => {
        expect(AgentScope.TENANT).toBe('tenant');
        expect(AgentScope.MISSION).toBe('mission');
        expect(AgentScope.IDEA).toBe('idea');
        expect(AgentScope.WORK).toBe('work');
    });

    it('exposes the AgentStatus enum values', () => {
        expect(AgentStatus.DRAFT).toBe('draft');
        expect(AgentStatus.ACTIVE).toBe('active');
        expect(AgentStatus.RUNNING).toBe('running');
        expect(AgentStatus.PAUSED).toBe('paused');
        expect(AgentStatus.ERROR).toBe('error');
        expect(AgentStatus.ARCHIVED).toBe('archived');
    });

    it('exports the conservative default permissions (all false)', () => {
        expect(Object.values(AGENT_PERMISSIONS_DEFAULT).every((v) => v === false)).toBe(true);
        expect(Object.keys(AGENT_PERMISSIONS_DEFAULT)).toEqual([
            'canCreateAgents',
            'canAssignTasks',
            'canEditSkills',
            'canEditAgentFiles',
            'canSpend',
            'canCommitToRepo',
            'canOpenPullRequests',
            'canCallExternalTools',
        ]);
    });
});
