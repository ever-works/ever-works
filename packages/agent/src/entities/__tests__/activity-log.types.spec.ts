import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
    type ActivityLogQueryOptions,
} from '../activity-log.types';

/**
 * `activity-log.types.ts` defines the contract that gets written into
 * `activity_log` rows and queried back from `/api/activity-log/*` endpoints.
 * Every enum literal here is matched via string equality across the
 * codebase (e.g. listener filter chains, DB queries, API DTOs), so a
 * silent rename is a backwards-incompat break for every persisted row.
 */
describe('activity-log.types', () => {
    describe('ActivityActionType — pinned literal values', () => {
        // Pin every documented literal so a rename surfaces in the test
        // diff. The values are persisted in DB rows and matched via string
        // equality across the codebase.
        const cases: Array<[keyof typeof ActivityActionType, string]> = [
            // Generation
            ['GENERATION', 'generation'],
            ['COMPARISON_GENERATION', 'comparison_generation'],
            // Deployment
            ['DEPLOYMENT', 'deployment'],
            // Work lifecycle
            ['WORK_CREATED', 'work_created'],
            ['WORK_UPDATED', 'work_updated'],
            ['WORK_DELETED', 'work_deleted'],
            // Items
            ['ITEM_ADDED', 'item_added'],
            ['ITEM_UPDATED', 'item_updated'],
            ['ITEM_REMOVED', 'item_removed'],
            // Plugins
            ['PLUGIN_ENABLED', 'plugin_enabled'],
            ['PLUGIN_DISABLED', 'plugin_disabled'],
            ['PLUGIN_CONFIGURED', 'plugin_configured'],
            // Templates
            ['TEMPLATE_ADDED', 'template_added'],
            ['TEMPLATE_UPDATED', 'template_updated'],
            ['TEMPLATE_ARCHIVED', 'template_archived'],
            ['TEMPLATE_FORKED', 'template_forked'],
            ['TEMPLATE_DEFAULT_SET', 'template_default_set'],
            // Members
            ['MEMBER_INVITED', 'member_invited'],
            ['MEMBER_ROLE_CHANGED', 'member_role_changed'],
            ['MEMBER_REMOVED', 'member_removed'],
            // Schedule
            ['SCHEDULE_CREATED', 'schedule_created'],
            ['SCHEDULE_UPDATED', 'schedule_updated'],
            ['SCHEDULE_DELETED', 'schedule_deleted'],
            ['SCHEDULE_EXECUTED', 'schedule_executed'],
            // Import / Export
            ['IMPORT', 'import'],
            ['EXPORT', 'export'],
            // Settings
            ['SETTINGS_UPDATED', 'settings_updated'],
            ['WEBSITE_SETTINGS_UPDATED', 'website_settings_updated'],
            ['PROMPTS_UPDATED', 'prompts_updated'],
            ['WORKS_CONFIG_SYNC', 'works_config_sync'],
            // Auth / Account
            ['USER_LOGIN', 'user_login'],
            ['USER_SIGNUP', 'user_signup'],
            ['PROVIDER_CONNECTED', 'provider_connected'],
            ['PASSWORD_CHANGED', 'password_changed'],
            // Chat / AI
            ['CHAT_CONVERSATION', 'chat_conversation'],
            // Community
            ['COMMUNITY_PR_MERGED', 'community_pr_merged'],
        ];

        it.each(cases)('%s → %s', (key, value) => {
            expect(ActivityActionType[key]).toBe(value);
        });

        it('has the expected total number of literal values (catch silent additions)', () => {
            // 51 documented literals — pinned so any silent addition is a
            // deliberate change. Last bumped by EW-641 Phase 1B/b (5
            // KB_UPLOAD_* + 3 KB_DOCUMENT_* values for the Knowledge
            // Base ingest pipeline + document lifecycle events).
            const literals = Object.values(ActivityActionType).filter((v) => typeof v === 'string');
            expect(literals).toHaveLength(51);
        });

        it('every literal value is unique (no accidental duplicate string)', () => {
            const literals = Object.values(ActivityActionType).filter((v) => typeof v === 'string');
            const seen = new Set(literals);
            expect(seen.size).toBe(literals.length);
        });

        it('every literal is lowercase snake_case (no UPPER or kebab)', () => {
            const literals = Object.values(ActivityActionType).filter(
                (v) => typeof v === 'string',
            ) as string[];
            for (const v of literals) {
                expect(v).toMatch(/^[a-z][a-z0-9_]*$/);
            }
        });
    });

    describe('ActivityStatus — pinned literal values', () => {
        const cases: Array<[keyof typeof ActivityStatus, string]> = [
            ['PENDING', 'pending'],
            ['IN_PROGRESS', 'in_progress'],
            ['COMPLETED', 'completed'],
            ['FAILED', 'failed'],
            ['CANCELLED', 'cancelled'],
        ];

        it.each(cases)('%s → %s', (key, value) => {
            expect(ActivityStatus[key]).toBe(value);
        });

        it('has exactly 5 documented literal values', () => {
            const literals = Object.values(ActivityStatus).filter((v) => typeof v === 'string');
            expect(literals).toHaveLength(5);
        });

        it('every literal value is unique', () => {
            const literals = Object.values(ActivityStatus).filter((v) => typeof v === 'string');
            expect(new Set(literals).size).toBe(literals.length);
        });
    });

    describe('CreateActivityLogDto — accepts every documented field shape', () => {
        it('accepts a minimal DTO with only the required fields', () => {
            const dto: CreateActivityLogDto = {
                userId: 'u1',
                actionType: ActivityActionType.WORK_CREATED,
                action: 'work.created',
                status: ActivityStatus.COMPLETED,
                summary: 'Work created',
            };
            expect(dto.userId).toBe('u1');
            expect(dto.actionType).toBe('work_created');
            expect(dto.summary).toBe('Work created');
        });

        it('accepts every optional field', () => {
            const dto: CreateActivityLogDto = {
                userId: 'u1',
                workId: 'w1',
                actionType: ActivityActionType.GENERATION,
                action: 'work.generation_started',
                status: ActivityStatus.IN_PROGRESS,
                summary: 'Generation started',
                details: { provider: 'openai' },
                metadata: { duration: 1234 },
                ipAddress: '192.0.2.1',
                userAgent: 'Mozilla/5.0',
            };
            expect(dto.workId).toBe('w1');
            expect(dto.details).toEqual({ provider: 'openai' });
            expect(dto.metadata).toEqual({ duration: 1234 });
            expect(dto.ipAddress).toBe('192.0.2.1');
            expect(dto.userAgent).toBe('Mozilla/5.0');
        });

        it('actionType is constrained to the enum (validated at compile time)', () => {
            // This test exists to ensure the type union is connected to the
            // enum — a runtime check that the dto's actionType field is set
            // to a known enum value.
            const dto: CreateActivityLogDto = {
                userId: 'u',
                actionType: ActivityActionType.SCHEDULE_EXECUTED,
                action: 'work.schedule.executed',
                status: ActivityStatus.COMPLETED,
                summary: '',
            };
            expect(Object.values(ActivityActionType)).toContain(dto.actionType);
        });
    });

    describe('ActivityLogQueryOptions — accepts every documented field shape', () => {
        it('accepts a minimal query with only userId', () => {
            const opts: ActivityLogQueryOptions = { userId: 'u1' };
            expect(opts.userId).toBe('u1');
        });

        it('accepts every optional filter', () => {
            const dateFrom = new Date('2026-05-01T00:00:00Z');
            const dateTo = new Date('2026-05-31T23:59:59Z');
            const opts: ActivityLogQueryOptions = {
                userId: 'u1',
                actionType: ActivityActionType.ITEM_ADDED,
                workId: 'w1',
                status: ActivityStatus.COMPLETED,
                dateFrom,
                dateTo,
                search: 'foo',
                limit: 100,
                offset: 50,
            };
            expect(opts.actionType).toBe('item_added');
            expect(opts.dateFrom).toBe(dateFrom);
            expect(opts.dateTo).toBe(dateTo);
            expect(opts.search).toBe('foo');
            expect(opts.limit).toBe(100);
            expect(opts.offset).toBe(50);
        });
    });
});
