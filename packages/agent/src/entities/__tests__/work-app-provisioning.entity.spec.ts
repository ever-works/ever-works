import { getMetadataArgsStorage } from 'typeorm';
import {
    APP_PROVISIONING_DETECTION_SOURCES,
    APP_PROVISIONING_FAILURE_REASONS,
    APP_PROVISIONING_PARK_REASONS,
    APP_PROVISIONING_QUESTION_REASONS,
    APP_PROVISIONING_STATUSES,
    APP_PROVISIONING_STEPS,
    APP_PROVISIONING_STEP_STATES,
} from '@ever-works/contracts';
import { WorkAppProvisioning } from '../work-app-provisioning.entity';
import { APP_PROVISIONING_ACTIVE_STATUSES } from '../../database/repositories/work-app-provisioning.repository';

/**
 * APW-04 T7 — the `WorkAppProvisioning` entity's shape, pinned against the
 * migration (T8) and plan §3.1's column table.
 *
 * Plan §3.1 (`plan.md:346-398`) is the normative column list: **56 columns**,
 * the six indexes of `:387-394`, and one `@ManyToOne(() => Work, { onDelete:
 * 'CASCADE' })` — the ONLY relation, because `taskId` and `agentId` carry no
 * foreign key (the entity-cycle rule, `plan.md:356`) and `tenantId` /
 * `organizationId` are scope stamps with no relation (EW-654/EW-655).
 *
 * What matters here, in the order T7 states it:
 *
 *  - the six index NAMES, with the columns and the uniqueness the plan fixes;
 *  - the three PARTIAL predicates — `uq_work_app_provisionings_active` on
 *    `(workId)` over the three active statuses, `uq_work_app_provisionings_task`
 *    on `(taskId)` where it is not null, and
 *    `uq_work_app_provisionings_suggestion` on `(suggestionUpstream)` where the
 *    state is `queued` — because a plain unique on `workId` would make
 *    re-provisioning (FR-59) impossible;
 *  - the partial predicate's three statuses ARE `APP_PROVISIONING_ACTIVE_STATUSES`,
 *    the constant the repository's four active queries use, so the index and the
 *    readers cannot disagree about what "active" means;
 *  - both scope columns, present as plain nullable uuids with no relation;
 *  - `parkedReason` / `parkedAt`, `questionReason` / `questionParams` and
 *    `lastRunOutput` present, nullable, and of the widths §3.1 gives them;
 *  - every date column a `PortableDateColumn` (`type: 'Date'`, never a raw
 *    `timestamp`), which `entities/__tests__/portable-date-columns.spec.ts`
 *    fails the build on for the same reason one bug class earlier.
 */

describe('WorkAppProvisioning entity (APW-04 T7)', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === WorkAppProvisioning);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const propertyNames = columns.map((entry) => entry.propertyName);
    const indices = storage.indices.filter((entry) => entry.target === WorkAppProvisioning);
    const relations = storage.relations.filter((entry) => entry.target === WorkAppProvisioning);

    /** The 56 columns of plan §3.1:352-383, verbatim and complete. */
    const PLAN_COLUMNS = [
        'id',
        'workId',
        'userId',
        'tenantId',
        'organizationId',
        'taskId',
        'agentId',
        'trigger',
        'status',
        'queuedReason',
        'step',
        'stepStates',
        'detectionSource',
        'verified',
        'failureReason',
        'baseSha',
        'headSha',
        'prNumber',
        'prUrl',
        'attempts',
        'attemptBudget',
        'attemptsUsed',
        'questionsAsked',
        'openInboxItemId',
        'questionAskedAt',
        'questionRemindedAt',
        'questionReason',
        'questionParams',
        'tokensUsed',
        'tokenCap',
        'runnerMinutesUsed',
        'runnerMinuteCap',
        'activeMs',
        'parkedReason',
        'parkedAt',
        'runIds',
        'buildIds',
        'lastRunOutput',
        'verificationTargetKind',
        'verificationNamespace',
        'verificationExpiresAt',
        'conversationId',
        'chatMessagesPosted',
        'note',
        'upstreamFromSha',
        'upstreamToSha',
        'suggestionState',
        'suggestionUpstream',
        'suggestedAt',
        'suggestionBundle',
        'lease',
        'leaseExpiresAt',
        'startedAt',
        'finishedAt',
        'createdAt',
        'updatedAt',
    ];

    /** The eight `PortableDateColumn` dates of §3.1 (the two audit stamps are the TypeORM helpers). */
    const PORTABLE_DATE_COLUMNS = [
        'questionAskedAt',
        'questionRemindedAt',
        'parkedAt',
        'verificationExpiresAt',
        'suggestedAt',
        'leaseExpiresAt',
        'startedAt',
        'finishedAt',
    ];

    /** The six indexes of plan §3.1:387-394, in the order the plan lists them. */
    const PLAN_INDEXES = [
        'uq_work_app_provisionings_active',
        'uq_work_app_provisionings_task',
        'idx_work_app_provisionings_user_status',
        'idx_work_app_provisionings_org_status',
        'idx_work_app_provisionings_expiry',
        'uq_work_app_provisionings_suggestion',
    ];

    describe('table and columns (plan §3.1)', () => {
        it('maps to work_app_provisionings', () => {
            const table = storage.tables.find((entry) => entry.target === WorkAppProvisioning);

            expect(table?.name).toBe('work_app_provisionings');
        });

        it('declares exactly the 56 columns of plan §3.1, and nothing else', () => {
            expect(columns).toHaveLength(56);
            expect([...propertyNames].sort()).toEqual([...PLAN_COLUMNS].sort());
        });

        it('requires the four columns a row cannot exist without', () => {
            for (const name of ['workId', 'userId', 'trigger', 'status']) {
                expect(column(name)?.options.nullable).not.toBe(true);
            }
        });

        it('uses the plan’s widths for the ids, states, hashes and the note', () => {
            const widths: Array<[string, number]> = [
                ['trigger', 24],
                ['status', 16],
                ['queuedReason', 24],
                ['step', 16],
                ['detectionSource', 24],
                ['failureReason', 40],
                ['baseSha', 64],
                ['headSha', 64],
                ['prUrl', 512],
                ['verificationTargetKind', 16],
                ['verificationNamespace', 63],
                ['upstreamFromSha', 64],
                ['upstreamToSha', 64],
                ['suggestionState', 16],
                ['suggestionUpstream', 200],
                ['lease', 36],
                ['note', 500],
            ];

            for (const [name, length] of widths) {
                expect(column(name)?.options.type).toBe('varchar');
                expect(column(name)?.options.length).toBe(length);
            }
        });

        it('leaves every derived-but-not-yet-known column nullable', () => {
            for (const name of [
                'taskId',
                'agentId',
                'queuedReason',
                'stepStates',
                'detectionSource',
                'verified',
                'failureReason',
                'baseSha',
                'headSha',
                'prNumber',
                'prUrl',
                'attempts',
                'openInboxItemId',
                'questionReason',
                'questionParams',
                'parkedReason',
                'runIds',
                'buildIds',
                'lastRunOutput',
                'verificationTargetKind',
                'verificationNamespace',
                'conversationId',
                'note',
                'upstreamFromSha',
                'upstreamToSha',
                'suggestionState',
                'suggestionUpstream',
                'suggestionBundle',
                'lease',
                'tenantId',
                'organizationId',
            ]) {
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('carries the two counters as bigint, so a 10,000,000 token cap fits exactly', () => {
            for (const name of ['tokensUsed', 'tokenCap', 'activeMs']) {
                expect(column(name)?.options.type).toBe('bigint');
            }
        });
    });

    describe('defaults a fresh row starts with (plan §3.1:368, :371-373, :378)', () => {
        it('starts with the plan’s attempt budget and empty counters', () => {
            expect(column('attemptBudget')?.options.default).toBe(3);
            expect(column('attemptsUsed')?.options.default).toBe(0);
            expect(column('questionsAsked')?.options.default).toBe(0);
        });

        it('starts with the plan’s caps and no spend', () => {
            expect(column('tokensUsed')?.options.default).toBe(0);
            expect(column('tokenCap')?.options.default).toBe(3_000_000);
            expect(column('runnerMinutesUsed')?.options.default).toBe(0);
            expect(column('runnerMinuteCap')?.options.default).toBe(240);
            expect(column('activeMs')?.options.default).toBe(0);
            expect(column('chatMessagesPosted')?.options.default).toBe(0);
        });

        it('starts on the first step, and gives no default to the columns a run writes', () => {
            expect(column('step')?.options.default).toBe('repository');
            expect(APP_PROVISIONING_STEPS[0]).toBe('repository');

            // NULL on any of these means "not known yet", which the card reads
            // as a fact — a default would erase it.
            for (const name of [
                'detectionSource',
                'verified',
                'failureReason',
                'baseSha',
                'headSha',
                'prNumber',
                'prUrl',
                'parkedReason',
                'parkedAt',
                'startedAt',
                'finishedAt',
                'lease',
                'leaseExpiresAt',
            ]) {
                expect(column(name)?.options.default).toBeUndefined();
            }
        });
    });

    describe('every date column is a PortableDateColumn (plan §3.1:383)', () => {
        it.each(PORTABLE_DATE_COLUMNS)(
            '%s holds a portable Date, not a driver timestamp',
            (name) => {
                const options = column(name)?.options;

                // `PortableDateColumn` passes `type: Date`, which is the `Date`
                // constructor itself — a raw `'timestamp'` string here would be
                // `timestamptz` on PostgreSQL and `datetime` on SQLite.
                expect(options?.type).toBe(Date);
            },
        );

        it('carries the question’s two instants, and leaves both nullable', () => {
            for (const name of ['questionAskedAt', 'questionRemindedAt']) {
                expect(column(name)?.options.type).toBe(Date);
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('carries the lease expiry and the two run stamps', () => {
            for (const name of ['leaseExpiresAt', 'startedAt', 'finishedAt']) {
                expect(column(name)?.options.type).toBe(Date);
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('carries createdAt / updatedAt as the two TypeORM date columns', () => {
            expect(column('createdAt')?.mode).toBe('createDate');
            expect(column('updatedAt')?.mode).toBe('updateDate');
        });
    });

    describe('the six indexes (plan §3.1:387-394)', () => {
        it('declares exactly the six index names the plan fixes, and no seventh', () => {
            expect([...indices.map((entry) => entry.name)].sort()).toEqual(
                [...PLAN_INDEXES].sort(),
            );
            expect(indices).toHaveLength(6);
        });

        it('makes the ACTIVE predicate a PARTIAL unique on (workId) — ACC-04-03', () => {
            const active = indices.find(
                (entry) => entry.name === 'uq_work_app_provisionings_active',
            );

            expect(active?.columns).toEqual(['workId']);
            expect(active?.unique).toBe(true);
            expect(active?.where).toBe("status IN ('queued', 'running', 'needs_input')");
        });

        it('spells the active predicate with the constant every active query uses', () => {
            // The index's WHERE and the repository's four active lookups must
            // mean the same three statuses; this is the pin that keeps them from
            // drifting apart in two files.
            expect(APP_PROVISIONING_ACTIVE_STATUSES).toEqual(['queued', 'running', 'needs_input']);
            for (const status of APP_PROVISIONING_ACTIVE_STATUSES) {
                expect(APP_PROVISIONING_STATUSES).toContain(status);
            }
        });

        it('makes the Task lookup a PARTIAL unique on (taskId) where it is not null', () => {
            const task = indices.find((entry) => entry.name === 'uq_work_app_provisionings_task');

            expect(task?.columns).toEqual(['taskId']);
            expect(task?.unique).toBe(true);
            expect(task?.where).toBe('"taskId" IS NOT NULL');
            // A NULL taskId on every queued row must not collide, which is what
            // the predicate is for; the column itself stays nullable.
            expect(column('taskId')?.options.nullable).toBe(true);
        });

        it('makes the Blueprint suggestion a PARTIAL unique on (suggestionUpstream) where queued', () => {
            const suggestion = indices.find(
                (entry) => entry.name === 'uq_work_app_provisionings_suggestion',
            );

            expect(suggestion?.columns).toEqual(['suggestionUpstream']);
            expect(suggestion?.unique).toBe(true);
            expect(suggestion?.where).toBe('"suggestionState" = \'queued\'');
            expect(column('suggestionState')?.options.nullable).toBe(true);
        });

        it('indexes the two cap counters by (scope, status), plain and non-unique', () => {
            const user = indices.find(
                (entry) => entry.name === 'idx_work_app_provisionings_user_status',
            );
            const org = indices.find(
                (entry) => entry.name === 'idx_work_app_provisionings_org_status',
            );

            expect(user?.columns).toEqual(['userId', 'status']);
            expect(user?.unique).not.toBe(true);
            expect(user?.where).toBeUndefined();
            expect(org?.columns).toEqual(['organizationId', 'status']);
            expect(org?.unique).not.toBe(true);
            expect(org?.where).toBeUndefined();
        });

        it('indexes the sweeper’s expiry column', () => {
            const expiry = indices.find(
                (entry) => entry.name === 'idx_work_app_provisionings_expiry',
            );

            expect(expiry?.columns).toEqual(['verificationExpiresAt']);
            expect(expiry?.unique).not.toBe(true);
            expect(expiry?.where).toBeUndefined();
        });

        it('is partial in exactly three places — a plain unique on workId would forbid re-provisioning', () => {
            const partial = indices.filter((entry) => entry.where !== undefined);

            expect(partial.map((entry) => entry.name).sort()).toEqual(
                [
                    'uq_work_app_provisionings_active',
                    'uq_work_app_provisionings_suggestion',
                    'uq_work_app_provisionings_task',
                ].sort(),
            );
        });
    });

    describe('relations and scope columns', () => {
        it('cascades on the Work, because the row describes the Work', () => {
            expect(relations).toHaveLength(1);
            expect(relations[0].propertyName).toBe('work');
            expect(relations[0].relationType).toBe('many-to-one');
            expect(relations[0].options.onDelete).toBe('CASCADE');
        });

        it('gives taskId and agentId NO foreign key — the entity-cycle rule', () => {
            // The only relation is `work`; a Task relation here would drag the
            // Task entity graph into the whole inventory's decorator evaluation.
            expect(relations.map((entry) => entry.propertyName)).toEqual(['work']);
            for (const name of ['taskId', 'agentId', 'conversationId', 'openInboxItemId']) {
                expect(column(name)?.options.type).toBe('uuid');
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('stamps tenantId / organizationId as plain columns with no relation', () => {
            for (const name of ['tenantId', 'organizationId']) {
                expect(column(name)?.options.type).toBe('uuid');
                expect(column(name)?.options.nullable).toBe(true);
            }

            expect(relations).toHaveLength(1);
        });
    });

    describe('the closed sets come from @ever-works/contracts (T6)', () => {
        it.each([
            [
                'trigger',
                24,
                ['auto-create', 'manual', 'chat', 'upstream-smoke', 'auto-upstream-smoke'],
            ],
            ['status', 16, APP_PROVISIONING_STATUSES],
            ['step', 16, APP_PROVISIONING_STEPS],
            ['detectionSource', 24, APP_PROVISIONING_DETECTION_SOURCES],
            ['failureReason', 40, APP_PROVISIONING_FAILURE_REASONS],
            ['questionReason', 24, APP_PROVISIONING_QUESTION_REASONS],
            ['parkedReason', 24, APP_PROVISIONING_PARK_REASONS],
        ])('gives %s a width that holds every member of its union', (name, width, members) => {
            const columnWidth = Number(column(name as string)?.options.length ?? 0);

            expect(columnWidth).toBe(width);
            for (const member of members as readonly string[]) {
                expect(member.length).toBeLessThanOrEqual(columnWidth);
            }
        });

        it('gives the state column every member of the step-state union, as stored JSON', () => {
            // `stepStates` is `simple-json`, so the member widths are bounded by
            // the union's longest member rather than by a column width.
            const longest = Math.max(...APP_PROVISIONING_STEP_STATES.map((state) => state.length));

            expect(longest).toBeLessThanOrEqual('needs_input'.length + 4);
            expect(column('stepStates')?.options.type).toBe('simple-json');
        });
    });

    describe('the JSON columns and the one text column', () => {
        it('stores the step table, the attempts and the three bags as simple-json, nullable', () => {
            for (const name of [
                'stepStates',
                'attempts',
                'questionParams',
                'runIds',
                'buildIds',
                'suggestionBundle',
            ]) {
                expect(column(name)?.options.type).toBe('simple-json');
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('stores the session output as nullable text — 512 KB, cleared after the guard reads it', () => {
            expect(column('lastRunOutput')?.options.type).toBe('text');
            expect(column('lastRunOutput')?.options.nullable).toBe(true);
        });
    });

    describe('APW04 T7 — the columns the plan calls out by name', () => {
        it('carries the park pair, the question pair and the run output', () => {
            // §3.1:370 and :374 : the plan names these five by name in T7's own
            // text, so their absence is a task failure rather than a taste call.
            for (const name of [
                'parkedReason',
                'parkedAt',
                'questionReason',
                'questionParams',
                'lastRunOutput',
            ]) {
                expect(column(name)).toBeDefined();
            }

            expect(column('parkedReason')?.options.nullable).toBe(true);
            expect(column('parkedAt')?.options.nullable).toBe(true);
            expect(column('questionReason')?.options.nullable).toBe(true);
            expect(column('questionParams')?.options.nullable).toBe(true);
        });

        it('never carries a column named like a secret value', () => {
            // `questionParams` is names only and `lastRunOutput` is cleared after
            // the guard reads it; a `tokens`/`secret`/`value` column would be the
            // first sign that a value had been stored.
            for (const forbidden of [
                'questionValue',
                'secretValue',
                'promptedValue',
                'envValues',
                'accessToken',
            ]) {
                expect(propertyNames).not.toContain(forbidden);
            }
        });
    });
});
