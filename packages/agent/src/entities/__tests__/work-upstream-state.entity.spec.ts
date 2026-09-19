import { getMetadataArgsStorage } from 'typeorm';
import {
    APP_ACTIONS_STATES,
    APP_READINESS_STATES,
    APP_REPOSITORY_MODES,
    APP_SYNC_RESULTS,
    APP_UPSTREAM_STATUSES,
} from '@ever-works/contracts';
import { WorkUpstreamState } from '../work-upstream-state.entity';

/**
 * APW-02 T12 — the `WorkUpstreamState` entity's shape, pinned against the
 * migration (T13) and the plan's column table so the three cannot drift apart
 * unnoticed.
 *
 * Plan §3.1 (`plan.md:205-259`) is the normative column list: **55 columns**,
 * three named indexes and one `@ManyToOne(() => Work, { onDelete: 'CASCADE' })`.
 * Spec FR-17…FR-52 are the behaviours those columns carry.
 *
 * What matters here, in the order the task states it: the three **index names**
 * the migration also creates, the **defaults** a fresh row starts with
 * (`preparing`, `unknown`, `available`, `pending`, the counters `0`), the
 * **scope columns** the plan puts on the row without a relation, and — the
 * assertion that keeps the entity honest — that every one of the 55 columns
 * named by the plan exists, and that no time column was written as a raw
 * `Date` (which would be `timestamptz` on Postgres and `datetime` on SQLite,
 * breaking the dispatcher's numeric `nextSyncAt <= :now`).
 *
 * The closed sets are read from `@ever-works/contracts` (APW-02 T11) rather
 * than re-listed: a column width that cannot hold its longest legal member, or
 * a union member the entity would reject, is a real defect and is asserted
 * against here.
 */
describe('WorkUpstreamState entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === WorkUpstreamState);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const propertyNames = columns.map((entry) => entry.propertyName);

    /**
     * The 55 columns of plan §3.1:210-256, verbatim and complete.
     *
     * APW-09 T43's credential column is NOT in this list on purpose — the list
     * is the plan's, and the epic's additive column is asserted beside it in
     * {@link APW09_COLUMNS} below, so "the plan's 55" and "what this row carries
     * today" stay two separate, checkable claims.
     */
    const PLAN_COLUMNS = [
        'id',
        'workId',
        'relation',
        'dataOwner',
        'dataRepo',
        'dataDefaultBranch',
        'upstreamOwner',
        'upstreamRepo',
        'upstreamDefaultBranch',
        'upstreamPreviousDefaultBranch',
        'readinessState',
        'readinessReason',
        'readinessStartedAt',
        'readinessHeartbeatAt',
        'readinessDispatches',
        'readinessManualRetries',
        'readinessManualWindowAt',
        'readyAt',
        'setupPullRequestUrl',
        'setupPullRequestNumber',
        'setupCheckedAt',
        'copyPushedSha',
        'aheadBy',
        'behindBy',
        'divergenceComputedAt',
        'behindEventCount',
        'upstreamHeadSha',
        'syncSchedule',
        'nextSyncAt',
        'syncStartedAt',
        'syncFinishedAt',
        'lastSyncResult',
        'lastSyncReason',
        'lastSyncedUpstreamSha',
        'lastSyncCommitCount',
        'syncPullRequestNumber',
        'syncPullRequestUrl',
        'syncPullRequestClosedHeadSha',
        'conflictTaskId',
        'manualSyncCount',
        'manualSyncWindowAt',
        'consecutiveRateLimited',
        'rateLimitedUntil',
        'upstreamStatus',
        'upstreamCheckedAt',
        'dataRepositoryStatus',
        'actionsState',
        'actionsSeenWorkflowIds',
        'actionsDisabledWorkflows',
        'actionsKeptWorkflows',
        'actionsCheckedAt',
        'tenantId',
        'organizationId',
        'createdAt',
        'updatedAt',
    ];

    /**
     * The one column APW-09 T43 (FR-43, XC-18) adds to the plan's list: the
     * member whose connection is the App Work's credential of record once a
     * handover records one. Kept apart from {@link PLAN_COLUMNS} so that list
     * stays the plan's verbatim 55, and asserted together with it below so the
     * entity and the migration
     * (`1792090000000-AddWorkUpstreamCredentialMember`) cannot drift apart.
     */
    const APW09_COLUMNS = ['credentialMemberUserId'];

    /** Every time column the plan gives a `bigint ts`. */
    const TIMESTAMP_COLUMNS = [
        'readinessStartedAt',
        'readinessHeartbeatAt',
        'readinessManualWindowAt',
        'readyAt',
        'setupCheckedAt',
        'divergenceComputedAt',
        'nextSyncAt',
        'syncStartedAt',
        'syncFinishedAt',
        'rateLimitedUntil',
        'upstreamCheckedAt',
        'actionsCheckedAt',
    ];

    describe('table and columns (plan §3.1)', () => {
        it('maps to work_upstream_states', () => {
            const table = storage.tables.find((entry) => entry.target === WorkUpstreamState);

            expect(table?.name).toBe('work_upstream_states');
        });

        it('declares exactly the 55 columns of plan §3.1 plus APW-09 T43’s credential column, and nothing else', () => {
            // The count and the set are both pinned: a column added here without
            // its migration is a schema the entity believes in and the database
            // does not have. The 55 are the plan's; the one APW-09 T43 adds is
            // named separately (APW09_COLUMNS) so the plan's own count stays a
            // separate, checkable claim.
            expect(columns).toHaveLength(56);
            expect([...propertyNames].sort()).toEqual([...PLAN_COLUMNS, ...APW09_COLUMNS].sort());
        });

        it('carries the required coordinates NOT NULL and the optional ones nullable', () => {
            // The Work Repository coordinates are what every job resolves; a
            // `link` row still has them (FR-44 only removes the UPSTREAM side).
            for (const name of ['relation', 'dataOwner', 'dataRepo', 'dataDefaultBranch']) {
                expect(column(name)?.options.nullable).not.toBe(true);
            }

            for (const name of [
                'upstreamOwner',
                'upstreamRepo',
                'upstreamDefaultBranch',
                'upstreamPreviousDefaultBranch',
                'readinessReason',
                'readinessHeartbeatAt',
                'readyAt',
                'setupPullRequestUrl',
                'setupPullRequestNumber',
                'setupCheckedAt',
                'copyPushedSha',
                'aheadBy',
                'behindBy',
                'divergenceComputedAt',
                'behindEventCount',
                'upstreamHeadSha',
                'syncSchedule',
                'nextSyncAt',
                'syncStartedAt',
                'syncFinishedAt',
                'lastSyncResult',
                'lastSyncReason',
                'lastSyncedUpstreamSha',
                'lastSyncCommitCount',
                'syncPullRequestNumber',
                'syncPullRequestUrl',
                'syncPullRequestClosedHeadSha',
                'conflictTaskId',
                'manualSyncWindowAt',
                'rateLimitedUntil',
                'upstreamCheckedAt',
                'actionsSeenWorkflowIds',
                'actionsDisabledWorkflows',
                'actionsKeptWorkflows',
                'actionsCheckedAt',
                'tenantId',
                'organizationId',
                // APW-09 T43 — a handover's record; NULL until one happens.
                'credentialMemberUserId',
            ]) {
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('carries the APW-09 T43 credential column as a nullable uuid with no default', () => {
            // Nullable is what makes the column addable to a non-empty table (the
            // API boots with `DATABASE_AUTOMIGRATE=true`), and the absent default
            // is what keeps NULL meaning "no handover" rather than "the empty
            // uuid". Both are pinned by the migration's own spec as well.
            expect(column('credentialMemberUserId')?.options.type).toBe('uuid');
            expect(column('credentialMemberUserId')?.options.nullable).toBe(true);
            expect(column('credentialMemberUserId')?.options.default).toBeUndefined();
        });

        it('keeps readinessStartedAt NOT NULL, so the sweeper always has a clock', () => {
            // plan.md:222. Try again resets it (FR-19); a row without one could
            // never be judged stale, so the plan does not allow one.
            expect(column('readinessStartedAt')?.options.nullable).not.toBe(true);
        });

        it('uses the plan’s widths for the sha, URL, branch and name columns', () => {
            const widths: Array<[string, number]> = [
                ['relation', 16],
                ['dataOwner', 100],
                ['dataRepo', 100],
                ['dataDefaultBranch', 255],
                ['upstreamOwner', 100],
                ['upstreamRepo', 100],
                ['upstreamDefaultBranch', 255],
                ['upstreamPreviousDefaultBranch', 255],
                ['readinessReason', 48],
                ['setupPullRequestUrl', 500],
                ['copyPushedSha', 40],
                ['upstreamHeadSha', 40],
                ['syncSchedule', 64],
                ['lastSyncReason', 48],
                ['lastSyncedUpstreamSha', 40],
                ['syncPullRequestUrl', 500],
                ['syncPullRequestClosedHeadSha', 40],
            ];

            for (const [name, length] of widths) {
                expect(column(name)?.options.type).toBe('varchar');
                expect(column(name)?.options.length).toBe(length);
            }
        });
    });

    describe('defaults a fresh row starts with (plan §3.1:220-251)', () => {
        it('starts preparing, with an unknown upstream, an available data repository and pending Actions', () => {
            expect(column('readinessState')?.options.default).toBe('preparing');
            expect(column('upstreamStatus')?.options.default).toBe('unknown');
            expect(column('dataRepositoryStatus')?.options.default).toBe('available');
            expect(column('actionsState')?.options.default).toBe('pending');
        });

        it('starts every counter at zero', () => {
            for (const name of [
                'readinessDispatches',
                'readinessManualRetries',
                'manualSyncCount',
                'consecutiveRateLimited',
            ]) {
                expect(column(name)?.options.type).toBe('int');
                expect(column(name)?.options.default).toBe(0);
            }
        });

        it('leaves the two rolling-window stamps with no default — NULL means “no window yet”', () => {
            for (const name of ['readinessManualWindowAt', 'manualSyncWindowAt']) {
                expect(column(name)?.options.default).toBeUndefined();
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('leaves nextSyncAt with no default — NULL is the paused state (FR-41, §6.4)', () => {
            expect(column('nextSyncAt')?.options.default).toBeUndefined();
            expect(column('nextSyncAt')?.options.nullable).toBe(true);
        });
    });

    describe('every time column is a TimestampColumn (bigint epoch ms)', () => {
        it.each(TIMESTAMP_COLUMNS)(
            '%s stores a bigint through the epoch-ms transformer',
            (name) => {
                const options = column(name)?.options;

                expect(options?.type).toBe('bigint');
                expect(typeof options?.transformer).toBe('object');
            },
        );

        it('round-trips a Date through the stored epoch — the dispatcher compares numbers', () => {
            const transformer = column('nextSyncAt')?.options.transformer as {
                to: (value?: Date) => unknown;
                from: (value?: unknown) => unknown;
            };
            const when = new Date('2026-03-01T06:00:00.000Z');

            expect(transformer.to(when)).toBe(when.getTime());
            expect((transformer.from(when.getTime()) as Date).getTime()).toBe(when.getTime());
            // A NULL column stays NULL in both directions: "paused", not 1970.
            expect(transformer.to(undefined)).toBeNull();
            expect(transformer.from(null)).toBeNull();
        });

        it('carries createdAt / updatedAt as the two TypeORM date columns', () => {
            const createdAt = column('createdAt');
            const updatedAt = column('updatedAt');

            expect(createdAt?.mode).toBe('createDate');
            expect(updatedAt?.mode).toBe('updateDate');
        });
    });

    describe('indexes the migration also creates (plan §3.1:258-259)', () => {
        const indices = storage.indices.filter((entry) => entry.target === WorkUpstreamState);

        it('declares exactly the three indexes the plan names', () => {
            expect(indices.map((entry) => entry.name).sort()).toEqual([
                'idx_work_upstream_states_next_sync',
                'idx_work_upstream_states_readiness',
                'uq_work_upstream_states_work',
            ]);
        });

        it('makes workId unique, so one App Work has one state row', () => {
            const unique = indices.find((entry) => entry.name === 'uq_work_upstream_states_work');

            expect(unique?.columns).toEqual(['workId']);
            expect(unique?.unique).toBe(true);
        });

        it('indexes the due scan and the stale-readiness sweep', () => {
            const due = indices.find(
                (entry) => entry.name === 'idx_work_upstream_states_next_sync',
            );
            const readiness = indices.find(
                (entry) => entry.name === 'idx_work_upstream_states_readiness',
            );

            expect(due?.columns).toEqual(['nextSyncAt']);
            expect(due?.unique).not.toBe(true);
            expect(readiness?.columns).toEqual(['readinessState', 'readinessHeartbeatAt']);
            expect(readiness?.unique).not.toBe(true);
        });
    });

    describe('relations and scope columns', () => {
        it('cascades on the Work, because the state describes the Work and nothing else', () => {
            expect(column('workId')?.options.type).toBe('uuid');
            expect(column('workId')?.options.nullable).not.toBe(true);

            const relations = storage.relations.filter(
                (entry) => entry.target === WorkUpstreamState,
            );
            expect(relations).toHaveLength(1);
            expect(relations[0].propertyName).toBe('work');
            expect(relations[0].relationType).toBe('many-to-one');
            expect(relations[0].options.onDelete).toBe('CASCADE');
        });

        it('stamps tenantId / organizationId as plain columns with no relation', () => {
            // Same reasoning as WorkDeployment (EW-654/EW-655): a relation here
            // would pull the Tenant/Organization graph into decorator evaluation
            // of the entity inventory.
            for (const name of ['tenantId', 'organizationId']) {
                expect(column(name)?.options.type).toBe('uuid');
                expect(column(name)?.options.nullable).toBe(true);
            }

            expect(
                storage.relations.filter((entry) => entry.target === WorkUpstreamState),
            ).toHaveLength(1);
        });

        it('keeps conflictTaskId a bare uuid — a deleted Task must not cascade', () => {
            // plan.md:244. Asserted as a column, and as the ABSENCE of a second
            // relation, which is what "no FK" means at metadata level.
            expect(column('conflictTaskId')?.options.type).toBe('uuid');
            expect(column('conflictTaskId')?.options.nullable).toBe(true);
            expect(
                storage.relations.some(
                    (entry) =>
                        entry.target === WorkUpstreamState && entry.propertyName === 'conflictTask',
                ),
            ).toBe(false);
        });
    });

    describe('the closed sets come from @ever-works/contracts (T11)', () => {
        it('gives relation a width that holds every APP_REPOSITORY_MODES member', () => {
            const width = Number(column('relation')?.options.length ?? 0);

            for (const member of APP_REPOSITORY_MODES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives readinessState a width that holds every APP_READINESS_STATES member', () => {
            const width = Number(column('readinessState')?.options.length ?? 0);

            for (const member of APP_READINESS_STATES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
            expect(column('readinessState')?.options.default).toBe(APP_READINESS_STATES[0]);
        });

        it('gives upstreamStatus a width that holds every APP_UPSTREAM_STATUSES member', () => {
            const width = Number(column('upstreamStatus')?.options.length ?? 0);

            for (const member of APP_UPSTREAM_STATUSES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives actionsState a width that holds every APP_ACTIONS_STATES member', () => {
            const width = Number(column('actionsState')?.options.length ?? 0);

            for (const member of APP_ACTIONS_STATES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives lastSyncResult a width that holds every APP_SYNC_RESULTS member', () => {
            const width = Number(column('lastSyncResult')?.options.length ?? 0);

            for (const member of APP_SYNC_RESULTS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });
    });

    describe('the JSON columns', () => {
        it('stores the three Actions workflow lists as simple-json, nullable', () => {
            for (const name of [
                'actionsSeenWorkflowIds',
                'actionsDisabledWorkflows',
                'actionsKeptWorkflows',
            ]) {
                expect(column(name)?.options.type).toBe('simple-json');
                expect(column(name)?.options.nullable).toBe(true);
            }
        });
    });
});
