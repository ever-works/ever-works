import { DataSource } from 'typeorm';
import { APP_SPEC_EVALUATE_COALESCE_MS } from '@ever-works/contracts';
import type { AppSpecEvaluationTrigger } from '@ever-works/contracts';
import { WorkAppSpecState } from '../../../entities/work-app-spec-state.entity';
import { Work } from '../../../entities/work.entity';
import { ENTITIES } from '../../_entities-inventory';
import { WorkRepository } from '../work.repository';
import {
    WORK_APP_SPEC_STATE_SCAN_MAX,
    WorkAppSpecStateRepository,
} from '../work-app-spec-state.repository';

/**
 * APW-03 T11 — the App spec state repository, executed against a real
 * (in-memory better-sqlite3) database rather than a mocked repository: the
 * conditional UPDATEs, the `bigint` sequence comparisons, the guarded
 * `dispatchedAt` window and the UNIQUE index are the ones production runs.
 *
 * better-sqlite3 is the default `DATABASE_TYPE` (every local and self-hosted
 * install) and the driver CI and the e2e lane use, so a coalescing rule that
 * only holds under a pooled driver is not a rule that holds.
 *
 * Spec FR-17, FR-20, FR-22, FR-59, FR-82 and ACC-03-12; plan §2.3
 * (`plan.md:168-201`), §2.5 step 0 (`plan.md:256-263`), §2.6 and §6.4
 * (`plan.md:678-686`) for how each method is called. Every uuid below is
 * obviously synthetic.
 */

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const WORK_C = '33333333-3333-4333-8333-333333333333';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A fixed "now" so every window is exact, never wall-clock flaky. */
const NOW = Date.parse('2026-03-01T06:00:00.000Z');
const COALESCE = APP_SPEC_EVALUATE_COALESCE_MS;

describe('WorkAppSpecStateRepository', () => {
    let dataSource: DataSource;
    let repository: WorkAppSpecStateRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        repository = new WorkAppSpecStateRepository(dataSource.getRepository(WorkAppSpecState));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        // The owning Work row is not what is under test for most cases; the FK
        // itself (and its cascade) is asserted in
        // `apps/api/.../CreateWorkAppSpecStates.spec.ts`, and the one test here
        // that needs it turns it on explicitly.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(WorkAppSpecState).clear();
        await dataSource.query('DELETE FROM "works"');
    });

    /** The four Work columns that carry no default (`work.entity.ts:166-274`). */
    function seedWork(workId: string, userId = USER_A, organizationId: string | null = null) {
        return dataSource.query(
            `INSERT INTO "works" ("id", "name", "slug", "userId", "description", "kind", "organizationId")
             VALUES ('${workId}', 'App Work ${workId.slice(0, 4)}', 'app-${workId.slice(0, 4)}', '${userId}', '', 'app', ${organizationId ? `'${organizationId}'` : 'NULL'})`,
        );
    }

    /** Insert a state row directly, so a test can start from any stored state. */
    function seedState(
        workId: string,
        overrides: Partial<WorkAppSpecState> = {},
    ): Promise<WorkAppSpecState> {
        const rows = dataSource.getRepository(WorkAppSpecState);
        return rows.save(rows.create({ workId, trackedBranch: 'main', ...overrides }));
    }

    /** Re-read a row from the database, never from the object a method returned. */
    async function stored(workId: string): Promise<WorkAppSpecState> {
        return dataSource.getRepository(WorkAppSpecState).findOneOrFail({ where: { workId } });
    }

    const evaluation = (
        overrides: Partial<Parameters<WorkAppSpecStateRepository['writeEvaluation']>[2]> = {},
    ): Parameters<WorkAppSpecStateRepository['writeEvaluation']>[2] => ({
        trigger: 'push' as AppSpecEvaluationTrigger,
        headCommitSha: 'a'.repeat(40),
        headSpecHash: 'b'.repeat(64),
        validationStatus: 'valid',
        errorCount: 0,
        warningCount: 0,
        issues: [],
        evaluatedAt: new Date(NOW),
        ...overrides,
    });

    describe('findByWorkId / initialize', () => {
        it('returns null for an App Work that has no state yet', async () => {
            expect(await repository.findByWorkId(WORK_A)).toBeNull();
        });

        it('starts a created row on the documented defaults', async () => {
            const created = await repository.initialize(WORK_A, 'trunk');

            const row = await stored(WORK_A);
            expect(row.id).toBe(created.id);
            expect(row.trackedBranch).toBe('trunk');
            // plan §3.1:409-449 — the values the App spec tab renders before
            // anything has been evaluated.
            expect(row.validationStatus).toBe('missing');
            expect(Number(row.requestedSeq)).toBe(0);
            expect(Number(row.startedSeq)).toBe(0);
            expect(Number(row.evaluatedSeq)).toBe(0);
            expect(Number(row.licenseRequestedSeq)).toBe(0);
            expect(Number(row.licenseEvaluatedSeq)).toBe(0);
            expect(Number(row.errorCount)).toBe(0);
            expect(Number(row.warningCount)).toBe(0);
            expect(Number(row.issuesTruncated)).toBe(0);
            expect(Number(row.licenseMixed)).toBe(0);
            expect(row.dispatchedAt ?? null).toBeNull();
            expect(row.headCommitSha ?? null).toBeNull();
            expect(row.effectiveCommitSha ?? null).toBeNull();
            expect(row.tenantId ?? null).toBeNull();
            expect(row.organizationId ?? null).toBeNull();
        });

        it('stamps the tenant and organization the create path knows about', async () => {
            await repository.initialize(WORK_A, 'main', {
                tenantId: 'tenant-1',
                organizationId: ORG_A,
            });

            const row = await stored(WORK_A);
            expect(row.tenantId).toBe('tenant-1');
            expect(row.organizationId).toBe(ORG_A);
        });

        it('is idempotent — a second initialize returns the row already there', async () => {
            const first = await repository.initialize(WORK_A, 'main');
            const second = await repository.initialize(WORK_A, 'a-different-branch');

            expect(second.id).toBe(first.id);
            // The branch the row was created with wins: initialize never moves
            // the tracked branch — FR-16's move is the evaluation's job.
            expect((await stored(WORK_A)).trackedBranch).toBe('main');
        });

        it('gives two App Works their own row', async () => {
            await repository.initialize(WORK_A, 'main');
            await repository.initialize(WORK_B, 'main');

            expect((await repository.findByWorkId(WORK_A))?.workId).toBe(WORK_A);
            expect((await repository.findByWorkId(WORK_B))?.workId).toBe(WORK_B);
        });
    });

    describe('requestEvaluation — the coalescing arithmetic (FR-22)', () => {
        beforeEach(async () => {
            await repository.initialize(WORK_A, 'main');
        });

        it('dispatches the first request and stamps dispatchedAt', async () => {
            const outcome = await repository.requestEvaluation(WORK_A, NOW);

            expect(outcome).toEqual({
                requested: true,
                dispatched: true,
                requestedSeq: 1,
                evaluatedSeq: 0,
            });
            const row = await stored(WORK_A);
            expect(row.dispatchedAt).toBeTruthy();
            // Pending: evaluatedSeq < requestedSeq is the DTO's
            // `evaluationPending` (plan §2.3:409).
            expect(Number(row.requestedSeq)).toBeGreaterThan(Number(row.evaluatedSeq));
        });

        it('coalesces a second request inside the window when no job has started', async () => {
            const first = await repository.requestEvaluation(WORK_A, NOW);
            const stamped = (await stored(WORK_A)).dispatchedAt;

            const second = await repository.requestEvaluation(WORK_A, NOW + 1_000);

            expect(first.dispatched).toBe(true);
            // The plan's condition, read as the plan writes it: the second
            // trigger inside the window whose job has NOT started does not
            // dispatch a second job (`APP_SPEC_EVALUATE_COALESCE_MS`).
            expect(second.dispatched).toBe(false);
            // The increment still happens on the coalesced branch: the row stays
            // pending and the job that eventually starts reads the newest
            // sequence, so the request is not lost — it is satisfied by the
            // evaluation already on its way.
            expect(second.requestedSeq).toBe(2);
            const row = await stored(WORK_A);
            expect(Number(row.requestedSeq)).toBe(2);
            expect(row.dispatchedAt).toEqual(stamped);
        });

        it('keeps coalescing a burst of requests, then dispatches one job that satisfies them all', async () => {
            await repository.requestEvaluation(WORK_A, NOW);
            const stamped = (await stored(WORK_A)).dispatchedAt;

            expect((await repository.requestEvaluation(WORK_A, NOW + 1_000)).dispatched).toBe(
                false,
            );
            expect((await repository.requestEvaluation(WORK_A, NOW + 2_000)).dispatched).toBe(
                false,
            );
            expect((await repository.requestEvaluation(WORK_A, NOW + 3_000)).dispatched).toBe(
                false,
            );

            // One job, claiming the newest sequence, which retires every request
            // the burst made.
            expect(await repository.markStarted(WORK_A)).toBe(4);
            expect((await stored(WORK_A)).dispatchedAt).toEqual(stamped);
        });

        it('coalesces exactly at the 5 s edge and dispatches one millisecond later', async () => {
            await repository.requestEvaluation(WORK_A, NOW);

            expect((await repository.requestEvaluation(WORK_A, NOW + COALESCE)).dispatched).toBe(
                false,
            );
            expect(
                (await repository.requestEvaluation(WORK_A, NOW + COALESCE + 1)).dispatched,
            ).toBe(true);
        });

        it('dispatches again as soon as the job has started, even inside the window', async () => {
            await repository.requestEvaluation(WORK_A, NOW);
            await repository.markStarted(WORK_A);

            // `startedSeq < requestedSeq - 1` is what makes the window apply:
            // a job IS running, so a new push is a new evaluation, not a
            // duplicate of one already on its way.
            const outcome = await repository.requestEvaluation(WORK_A, NOW + 500);

            expect(outcome.dispatched).toBe(true);
            expect(outcome.requestedSeq).toBe(2);
        });

        it('dispatches again once the window has elapsed with no job started', async () => {
            await repository.requestEvaluation(WORK_A, NOW);
            const stamped = (await stored(WORK_A)).dispatchedAt;

            const outcome = await repository.requestEvaluation(WORK_A, NOW + COALESCE + 1);

            expect(outcome.dispatched).toBe(true);
            expect(outcome.requestedSeq).toBe(2);
            expect((await stored(WORK_A)).dispatchedAt).not.toEqual(stamped);
        });

        it('dispatches for a row that has never been dispatched, whatever its sequences say', async () => {
            // No `dispatchedAt` means there is no window to measure: the coalescing
            // rule can only suppress a dispatch that a previous request made.
            await seedState(WORK_B, { requestedSeq: 5, startedSeq: 4, dispatchedAt: null });

            const outcome = await repository.requestEvaluation(WORK_B, NOW);

            expect(outcome.requested).toBe(true);
            expect(outcome.dispatched).toBe(true);
            expect(outcome.requestedSeq).toBe(6);
        });

        it('requests nothing at all for a deleted App Work (0 rows)', async () => {
            await repository.initialize(WORK_C, 'main');
            await seedWork(WORK_C);
            await repository.requestEvaluation(WORK_C, NOW);

            // The FK cascade takes the state row with the Work. The cascade is
            // asserted directly in the migration spec; what THIS method owes is
            // that it then affects 0 rows and raises no job for a Work that no
            // longer exists.
            await dataSource.query('PRAGMA foreign_keys = ON');
            expect(await dataSource.query('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
            expect(
                await dataSource.query(`PRAGMA foreign_key_list("work_app_spec_states")`),
            ).toHaveLength(1);

            await dataSource.query(`DELETE FROM "works" WHERE "id" = '${WORK_C}'`);

            expect(await repository.findByWorkId(WORK_C)).toBeNull();

            const outcome = await repository.requestEvaluation(WORK_C, NOW);

            expect(outcome).toEqual({
                requested: false,
                dispatched: false,
                requestedSeq: 0,
                evaluatedSeq: 0,
            });
        });
    });

    describe('markStarted', () => {
        it('stamps startedSeq from requestedSeq and returns the claimed sequence', async () => {
            await repository.initialize(WORK_A, 'main');
            await repository.requestEvaluation(WORK_A, NOW);

            expect(await repository.markStarted(WORK_A)).toBe(1);

            const row = await stored(WORK_A);
            expect(Number(row.startedSeq)).toBe(1);
            expect(Number(row.requestedSeq)).toBe(1);
        });

        it('claims the NEWEST request, so a coalesced push is picked up', async () => {
            await repository.initialize(WORK_A, 'main');
            await repository.requestEvaluation(WORK_A, NOW);
            await repository.requestEvaluation(WORK_A, NOW + 100);
            await repository.requestEvaluation(WORK_A, NOW + 200);

            expect(await repository.markStarted(WORK_A)).toBe(3);
        });

        it('answers null for an App Work whose row is gone', async () => {
            expect(await repository.markStarted(WORK_C)).toBeNull();
        });
    });

    describe('writeEvaluation', () => {
        beforeEach(async () => {
            await repository.initialize(WORK_A, 'main');
        });

        it('writes the result and advances evaluatedSeq', async () => {
            const written = await repository.writeEvaluation(WORK_A, 1, evaluation());

            expect(written).toBe(true);
            const row = await stored(WORK_A);
            expect(Number(row.evaluatedSeq)).toBe(1);
            expect(row.validationStatus).toBe('valid');
            expect(row.headCommitSha).toBe('a'.repeat(40));
            expect(row.headSpecHash).toBe('b'.repeat(64));
            expect(row.lastEvaluationTrigger).toBe('push');
            expect(Number(row.errorCount)).toBe(0);
            expect(Number(row.warningCount)).toBe(0);
            expect(row.lastEvaluatedAt).toBeTruthy();
            expect(Number(row.requestedSeq)).toBe(0);
        });

        it('an older evaluation writes nothing, so the newer result stays (ACC-03-12)', async () => {
            // Two evaluations in flight at once, the later one finishing first.
            const newer = evaluation({
                trigger: 'pr_merged',
                headCommitSha: 'c'.repeat(40),
                headSpecHash: 'd'.repeat(64),
                validationStatus: 'valid_with_warnings',
                warningCount: 3,
            });
            const older = evaluation({
                trigger: 'push',
                headCommitSha: 'e'.repeat(40),
                headSpecHash: 'f'.repeat(64),
                validationStatus: 'invalid',
                errorCount: 2,
            });

            expect(await repository.writeEvaluation(WORK_A, 2, newer)).toBe(true);
            expect(await repository.writeEvaluation(WORK_A, 1, older)).toBe(false);

            const row = await stored(WORK_A);
            expect(Number(row.evaluatedSeq)).toBe(2);
            expect(row.headCommitSha).toBe('c'.repeat(40));
            expect(row.headSpecHash).toBe('d'.repeat(64));
            expect(row.validationStatus).toBe('valid_with_warnings');
            expect(Number(row.warningCount)).toBe(3);
            expect(row.lastEvaluationTrigger).toBe('pr_merged');
            // Nothing of the older result survived the losing write.
            expect(Number(row.errorCount)).toBe(0);
        });

        it('refuses a second write for the same sequence', async () => {
            await repository.writeEvaluation(WORK_A, 1, evaluation());

            expect(await repository.writeEvaluation(WORK_A, 1, evaluation())).toBe(false);
        });

        it('keeps the effective spec when an invalid head is evaluated (ACC-03-10)', async () => {
            await repository.writeEvaluation(
                WORK_A,
                1,
                evaluation({
                    effectiveCommitSha: 'a'.repeat(40),
                    effectiveSpecHash: 'b'.repeat(64),
                    effectiveSpec: { kind: 'app' } as never,
                    effectiveAt: new Date(NOW),
                }),
            );

            // The invalid head carries no effective fields at all: absent means
            // "leave the column alone", which is what keeps the last valid
            // commit's spec buildable and deployable.
            await repository.writeEvaluation(
                WORK_A,
                2,
                evaluation({
                    validationStatus: 'invalid',
                    errorCount: 4,
                    issues: [
                        {
                            code: 'unknown_field',
                            severity: 'error',
                            path: '/spec/nope',
                            message: 'Unknown field',
                        },
                    ] as never,
                }),
            );

            const row = await stored(WORK_A);
            expect(row.validationStatus).toBe('invalid');
            expect(Number(row.errorCount)).toBe(4);
            expect(row.effectiveCommitSha).toBe('a'.repeat(40));
            expect(row.effectiveSpecHash).toBe('b'.repeat(64));
            expect(row.effectiveSpec).toEqual({ kind: 'app' });
        });

        it('records the tracked-branch move of FR-16 on the same guarded write', async () => {
            await repository.writeEvaluation(WORK_A, 1, evaluation({ trackedBranch: 'develop' }));

            expect((await stored(WORK_A)).trackedBranch).toBe('develop');
        });

        it('answers false for an App Work whose row is gone', async () => {
            expect(await repository.writeEvaluation(WORK_C, 1, evaluation())).toBe(false);
        });
    });

    describe('writeLicense', () => {
        beforeEach(async () => {
            await repository.initialize(WORK_A, 'main');
        });

        it('writes the classification and advances licenseEvaluatedSeq', async () => {
            const written = await repository.writeLicense(WORK_A, 1, {
                licenseSpdx: 'AGPL-3.0-only',
                licenseClass: 'green',
                licenseSource: 'detected',
                licenseMixed: false,
                licenseScanIncomplete: false,
                licenseEvidence: { files: ['LICENSE'], mixedPaths: [] },
                licenseObligations: ['network-source-offer'],
                licenseCommitSha: 'a'.repeat(40),
                licenseRegistryHash: 'h'.repeat(64),
                licenseRegistrySource: 'live',
                sourceOfferRequired: true,
                evaluatedAt: new Date(NOW),
            });

            expect(written).toBe(true);
            const row = await stored(WORK_A);
            expect(Number(row.licenseEvaluatedSeq)).toBe(1);
            expect(row.licenseSpdx).toBe('AGPL-3.0-only');
            expect(row.licenseClass).toBe('green');
            expect(row.licenseObligations).toEqual(['network-source-offer']);
            expect(Number(row.sourceOfferRequired)).toBe(1);
            expect(row.licenseEvaluatedAt).toBeTruthy();
        });

        it('leaves everything alone when a stale evaluation loses the race', async () => {
            await repository.writeLicense(WORK_A, 2, {
                licenseSpdx: 'MIT',
                licenseClass: 'green',
            });

            expect(
                await repository.writeLicense(WORK_A, 1, {
                    licenseSpdx: 'GPL-3.0-only',
                    licenseClass: 'red',
                }),
            ).toBe(false);

            const row = await stored(WORK_A);
            expect(Number(row.licenseEvaluatedSeq)).toBe(2);
            expect(row.licenseSpdx).toBe('MIT');
            expect(row.licenseClass).toBe('green');
        });

        it('clears the attestation when a later evaluation passes null (FR-59/FR-60)', async () => {
            await repository.writeLicense(WORK_A, 1, {
                licenseSpdx: 'BUSL-1.1',
                licenseClass: 'amber',
                attestation: {
                    userId: USER_A,
                    attestedAt: new Date(NOW).toISOString(),
                    spdx: 'BUSL-1.1',
                    class: 'amber',
                    textId: 'busl-1.1',
                    textSha256: 'x'.repeat(64),
                    commitSha: 'a'.repeat(40),
                } as never,
            });
            expect((await stored(WORK_A)).attestation).toBeTruthy();

            await repository.writeLicense(WORK_A, 2, {
                licenseSpdx: 'MIT',
                licenseClass: 'green',
                attestation: null,
            });

            expect((await stored(WORK_A)).attestation ?? null).toBeNull();
        });

        it('answers false for an App Work whose row is gone', async () => {
            expect(await repository.writeLicense(WORK_C, 1, { licenseSpdx: 'MIT' })).toBe(false);
        });
    });

    describe('markBlueprintMatched (plan §2.5 step 0, FR-82)', () => {
        beforeEach(async () => {
            await repository.initialize(WORK_A, 'main');
        });

        it('returns true once per blueprint id + version, and never twice', async () => {
            expect(
                await repository.markBlueprintMatched(WORK_A, 'umami', '1.2.0', 'manifest'),
            ).toBe(true);
            expect(
                await repository.markBlueprintMatched(WORK_A, 'umami', '1.2.0', 'manifest'),
            ).toBe(false);
            expect(await repository.markBlueprintMatched(WORK_A, 'umami', '1.2.0', 'probe')).toBe(
                false,
            );

            const row = await stored(WORK_A);
            expect(row.blueprintId).toBe('umami');
            expect(row.blueprintVersion).toBe('1.2.0');
            expect(row.blueprintMatchSource).toBe('manifest');
            expect(row.blueprintApplyStatus).toBe('applying');
            expect(row.blueprintMatchedAt).toBeTruthy();
        });

        it('returns true again for a NEW version, so an upgrade is recorded once too', async () => {
            await repository.markBlueprintMatched(WORK_A, 'umami', '1.2.0', 'manifest');

            expect(
                await repository.markBlueprintMatched(WORK_A, 'umami', '2.0.0', 'manifest'),
            ).toBe(true);
            expect(
                await repository.markBlueprintMatched(WORK_A, 'umami', '2.0.0', 'manifest'),
            ).toBe(false);

            expect((await stored(WORK_A)).blueprintVersion).toBe('2.0.0');
        });

        it('returns true again when the Work switches to a different Blueprint', async () => {
            await repository.markBlueprintMatched(WORK_A, 'umami', '1.0.0', 'manifest');

            expect(
                await repository.markBlueprintMatched(WORK_A, 'cal-diy', '1.0.0', 'explicit'),
            ).toBe(true);

            const row = await stored(WORK_A);
            expect(row.blueprintId).toBe('cal-diy');
            expect(row.blueprintMatchSource).toBe('explicit');
        });

        it('answers false for an App Work whose row is gone', async () => {
            expect(
                await repository.markBlueprintMatched(WORK_C, 'umami', '1.0.0', 'manifest'),
            ).toBe(false);
        });
    });

    describe('findUpgradeCandidates', () => {
        beforeEach(async () => {
            await repository.initialize(WORK_A, 'main');
            await repository.initialize(WORK_B, 'main');
            await repository.initialize(WORK_C, 'main');

            await repository.markBlueprintMatched(WORK_A, 'umami', '1.2.0', 'manifest');
            await repository.markBlueprintMatched(WORK_B, 'umami', '2.0.0', 'manifest');
            await repository.markBlueprintMatched(WORK_C, 'cal-diy', '1.0.0', 'manifest');
        });

        it('returns the Works on this Blueprint at some other version', async () => {
            const candidates = await repository.findUpgradeCandidates('umami', '2.0.0', 50);

            expect(candidates.map((row) => row.workId)).toEqual([WORK_A]);
        });

        it('never returns a row for the version the caller passed', async () => {
            // The candidate set is "this Blueprint, some other version": the
            // `semver.lt` comparison of plan §2.5:288 is the caller's, because
            // no portable SQL orders semver — so a Work already ON the catalog
            // version is excluded here and a newer one is left for the caller to
            // reject.
            const candidates = await repository.findUpgradeCandidates('umami', '1.2.0', 50);

            expect(candidates.map((row) => row.workId)).toEqual([WORK_B]);
        });

        it('never crosses Blueprints', async () => {
            expect(
                (await repository.findUpgradeCandidates('cal-diy', '9.9.9', 50)).map(
                    (row) => row.workId,
                ),
            ).toEqual([WORK_C]);
        });

        it('ignores rows with no Blueprint at all, and answers [] without an id', async () => {
            await repository.initialize('44444444-4444-4444-8444-444444444444', 'main');

            expect(await repository.findUpgradeCandidates('umami', '9.9.9', 50)).toHaveLength(2);
            expect(await repository.findUpgradeCandidates('', '9.9.9', 50)).toEqual([]);
        });

        it('clamps the batch to the documented ceiling', async () => {
            expect(WORK_APP_SPEC_STATE_SCAN_MAX).toBe(500);
            // A limit larger than the ceiling is clamped, not honoured.
            expect(await repository.findUpgradeCandidates('umami', '9.9.9', 10_000)).toHaveLength(
                2,
            );
        });
    });

    describe('findStaleRegistry (plan §6.4:682)', () => {
        beforeEach(async () => {
            await repository.initialize(WORK_A, 'main');
            await repository.initialize(WORK_B, 'main');
            await repository.initialize(WORK_C, 'main');

            await repository.writeLicense(WORK_A, 1, {
                licenseSpdx: 'MIT',
                licenseClass: 'green',
                licenseRegistryHash: 'old'.padEnd(64, '0'),
            });
            await repository.writeLicense(WORK_B, 1, {
                licenseSpdx: 'AGPL-3.0-only',
                licenseClass: 'green',
                licenseRegistryHash: 'live'.padEnd(64, '0'),
            });
            // WORK_C is never classified — a registry change cannot re-classify
            // what was never classified, and it must not be dispatched here.
        });

        it('returns only the Works classified against a different registry', async () => {
            const stale = await repository.findStaleRegistry('live'.padEnd(64, '0'), 50);

            expect(stale.map((row) => row.workId)).toEqual([WORK_A]);
        });

        it('treats a missing stored hash as stale', async () => {
            await repository.writeLicense(WORK_B, 2, {
                licenseSpdx: 'AGPL-3.0-only',
                licenseClass: 'green',
                licenseRegistryHash: null,
            });

            const stale = await repository.findStaleRegistry('live'.padEnd(64, '0'), 50);

            expect(stale.map((row) => row.workId).sort()).toEqual([WORK_A, WORK_B].sort());
            // Still never the unclassified Work.
            expect(stale.map((row) => row.workId)).not.toContain(WORK_C);
        });

        it('answers [] without a hash — nothing is "stale" against nothing', async () => {
            expect(await repository.findStaleRegistry('', 50)).toEqual([]);
        });

        it('clamps the batch to the documented ceiling', async () => {
            expect(await repository.findStaleRegistry('live'.padEnd(64, '0'), 10_000)).toHaveLength(
                1,
            );
        });
    });

    describe('WorkRepository.findAppWorksByDataRepoFullName (T11)', () => {
        // `work.repository.spec.ts` is not this task's file, so the new lookup
        // is covered here, against the same database and alongside the state
        // repository the push intake calls it with.
        const workRepository = () => new WorkRepository(dataSource.getRepository(Work));

        const appWork = (
            id: string,
            website: string | null,
            options: {
                userId?: string;
                organizationId?: string | null;
                kind?: string;
                githubAppInstalled?: boolean;
                dataRole?: string | null;
            } = {},
        ) =>
            dataSource.query(
                `INSERT INTO "works"
                    ("id", "name", "slug", "userId", "description", "kind", "organizationId",
                     "githubAppInstalled", "sourceRepository")
                 VALUES ('${id}', 'App ${id.slice(0, 4)}', 'app-${id.slice(0, 4)}',
                         '${options.userId ?? USER_A}', '', '${options.kind ?? 'app'}',
                         ${options.organizationId ? `'${options.organizationId}'` : 'NULL'},
                         ${options.githubAppInstalled === false ? 0 : 1},
                         '${JSON.stringify({
                             url: `https://github.com/${website ?? 'none/none'}`,
                             owner: (website ?? 'none/none').split('/')[0],
                             repo: (website ?? 'none/none').split('/')[1],
                             type: 'data_repo',
                             importedAt: '2026-03-01T00:00:00.000Z',
                             relatedRepositories: {
                                 ...(website ? { website: split(website) } : {}),
                                 ...(options.dataRole ? { data: split(options.dataRole) } : {}),
                             },
                         })}')`,
            );

        function split(fullName: string) {
            const [owner, repo] = fullName.split('/');
            return { owner, repo };
        }

        it('finds an App Work by its Work Repository (the `website` role), case-insensitively', async () => {
            await appWork(WORK_A, 'Member/My-App');

            const found = await workRepository().findAppWorksByDataRepoFullName('member/my-app', {
                userId: USER_A,
            });

            expect(found.map((work) => work.id)).toEqual([WORK_A]);
        });

        it('never matches the `data` role — an App Work’s code is the Work Repository', async () => {
            // The plan's own defect note (`plan.md:45`): matching `data` would
            // evaluate the repository holding the Work's data, not its code.
            await appWork(WORK_A, 'member/other-app', { dataRole: 'member/my-app' });

            expect(
                await workRepository().findAppWorksByDataRepoFullName('member/my-app', {
                    userId: USER_A,
                }),
            ).toEqual([]);
            expect(
                (
                    await workRepository().findAppWorksByDataRepoFullName('member/other-app', {
                        userId: USER_A,
                    })
                ).map((work) => work.id),
            ).toEqual([WORK_A]);
        });

        it('selects kind `app` only — a `repo` Work wrapping the same repository is not one', async () => {
            await appWork(WORK_A, 'member/my-app', { kind: 'repo' });

            expect(
                await workRepository().findAppWorksByDataRepoFullName('member/my-app', {
                    userId: USER_A,
                }),
            ).toEqual([]);
        });

        it('finds an App Work with no platform GitHub App installed (no `githubAppInstalled` filter)', async () => {
            // The normal Wave 1 case: a fork in the member's own account whose
            // webhook APW-02 created. `findByDataRepoFullName` cannot see it.
            await appWork(WORK_A, 'member/my-app', { githubAppInstalled: false });

            const found = await workRepository().findAppWorksByDataRepoFullName('member/my-app', {
                userId: USER_A,
            });
            expect(found.map((work) => work.id)).toEqual([WORK_A]);

            // The sibling lookup is unchanged: still gated on the App.
            expect(await workRepository().findByDataRepoFullName('member/my-app')).toEqual([]);
        });

        it('scopes a personal binding to that member’s own Works', async () => {
            await appWork(WORK_A, 'member/my-app', { userId: USER_A });
            await appWork(WORK_B, 'member/my-app', { userId: ORG_A });

            const found = await workRepository().findAppWorksByDataRepoFullName('member/my-app', {
                userId: USER_A,
            });

            expect(found.map((work) => work.id)).toEqual([WORK_A]);
        });

        it('scopes an organization binding to the Organization’s Works, whoever created them', async () => {
            // Two members of one Organization, two Works on the same repository
            // — an organization delivery must reach both and nothing else.
            await appWork(WORK_A, 'member/my-app', { userId: USER_A, organizationId: ORG_A });
            await appWork(WORK_B, 'member/my-app', { userId: ORG_A, organizationId: ORG_A });
            await appWork(WORK_C, 'member/my-app', { userId: USER_A, organizationId: null });

            const found = await workRepository().findAppWorksByDataRepoFullName('member/my-app', {
                organizationId: ORG_A,
            });

            expect(found.map((work) => work.id).sort()).toEqual([WORK_A, WORK_B].sort());
        });

        it('refuses to answer without a binding — no unscoped lookup exists', async () => {
            await appWork(WORK_A, 'member/my-app', { userId: USER_A });

            expect(await workRepository().findAppWorksByDataRepoFullName('member/my-app')).toEqual(
                [],
            );
            expect(
                await workRepository().findAppWorksByDataRepoFullName('member/my-app', {}),
            ).toEqual([]);
        });

        it('answers [] for a malformed repository name', async () => {
            await appWork(WORK_A, 'member/my-app', { userId: USER_A });

            expect(
                await workRepository().findAppWorksByDataRepoFullName('my-app', { userId: USER_A }),
            ).toEqual([]);
            expect(
                await workRepository().findAppWorksByDataRepoFullName('', { userId: USER_A }),
            ).toEqual([]);
        });
    });
});
