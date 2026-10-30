import { readFileSync } from 'fs';
import { join } from 'path';
import {
    APP_REPOSITORY_STAGE_LIMITS,
    firstRefusingRepositoryStage,
    type AppRepositoryStage,
} from '@ever-works/contracts';
import {
    APP_WORK_RUN_CHECKOUT_STAGE,
    appWorkRepositorySizeRefusal,
    appWorkRunStageSizeLimitKb,
    describeAppWorkRunRefusal,
    isAppWorkRunRefusal,
} from '../isolated-run-admission';
import {
    IsolatedRunAdmissionService,
    type IsolatedRunAdmissionReads,
} from '../isolated-run-admission.service';

/**
 * APW-08 T53 (XC-29, FR-72, S35, ACC-08-36) — repository size limits come from ONE table.
 *
 * The evolve loop's checkout ("Fleet or isolated sandbox") is the shared table's `sandbox` stage,
 * which states no size today, so nothing is refused and nothing is read. These specs pin the rule
 * against the table itself (a stage that HAS a limit, `provisioning`, 3 GiB) and prove the wiring:
 * the day a number is entered for `sandbox`, every App Work run checks against it with no change
 * to this epic's files.
 */
describe('APW-08 T53 — repository size limits from the shared table', () => {
    const GIB_KB = 1024 * 1024;
    const OWNER = 'user-1';
    const APP_WORK = 'work-app';

    describe('the pure rule', () => {
        it('reads the limit from the shared table, never a local number', () => {
            expect(appWorkRunStageSizeLimitKb('provisioning')).toBe(
                APP_REPOSITORY_STAGE_LIMITS.provisioning.maxSizeKb,
            );
            expect(appWorkRunStageSizeLimitKb('private-copy')).toBe(
                APP_REPOSITORY_STAGE_LIMITS['private-copy'].maxSizeKb,
            );
            // The run's checkout stage is `sandbox`, which the table leaves without a size today.
            expect(APP_WORK_RUN_CHECKOUT_STAGE).toBe('sandbox');
            expect(appWorkRunStageSizeLimitKb()).toBe(APP_REPOSITORY_STAGE_LIMITS.sandbox.maxSizeKb);
        });

        it('the refusing stage is the one Inspect names, and the copy carries the size and the limit (S35)', () => {
            const sizeKb = 4 * GIB_KB;
            const refusal = appWorkRepositorySizeRefusal({ sizeKb, stage: 'provisioning' });
            expect(refusal).not.toBeNull();
            expect(refusal!.stage).toBe(
                firstRefusingRepositoryStage({ sizeKb, stages: ['provisioning'] }),
            );
            expect(refusal).toMatchObject({
                admitted: false,
                outcome: 'refused',
                code: 'repositoryTooLarge',
                sizeKb,
                maxSizeKb: APP_REPOSITORY_STAGE_LIMITS.provisioning.maxSizeKb,
            });
            expect(refusal!.message).toBe(
                "This app's repository is too big to check out here (4.0 GB; this stage allows 3.0 GB).",
            );
            expect(describeAppWorkRunRefusal(refusal!)).toBe(
                `repositoryTooLarge: ${refusal!.message}`,
            );
        });

        it('a repository inside the limit is not refused; a stage with no limit refuses nothing', () => {
            expect(
                appWorkRepositorySizeRefusal({ sizeKb: 2 * GIB_KB, stage: 'provisioning' }),
            ).toBeNull();
            expect(
                appWorkRepositorySizeRefusal({ sizeKb: 3 * GIB_KB, stage: 'provisioning' }),
            ).toBeNull();
            expect(appWorkRepositorySizeRefusal({ sizeKb: 99 * GIB_KB, stage: 'build' })).toBeNull();
            expect(appWorkRepositorySizeRefusal({ sizeKb: null, stage: 'build' })).toBeNull();
        });

        it('an unmeasurable size is refused wherever a limit exists ("could not measure" is never "fits")', () => {
            for (const sizeKb of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
                const refusal = appWorkRepositorySizeRefusal({ sizeKb, stage: 'provisioning' });
                expect(refusal).toMatchObject({ code: 'repositoryTooLarge', sizeKb: null });
                expect(refusal!.message).toBe(
                    "This app's repository size could not be measured, so it was not checked out here (this stage allows 3.0 GB).",
                );
            }
        });

        it("no local size constant exists in this epic's admission files (source-text assertion)", () => {
            for (const file of ['isolated-run-admission.ts', 'isolated-run-admission.service.ts']) {
                const source = readFileSync(join(__dirname, '..', file), 'utf8');
                // A limit is a `maxSizeKb` set from a number, or a MAX_*SIZE* constant: neither may
                // appear here — the only numbers are the table's, read through the contracts.
                expect(source).not.toMatch(/maxSizeKb\s*[:=]\s*\d/);
                expect(source).not.toMatch(/MAX_\w*SIZE\w*\s*=\s*\d/);
            }
        });
    });

    describe('the admission (every site asks it before anything else)', () => {
        const work = {
            id: APP_WORK,
            userId: OWNER,
            kind: 'app',
            gitProvider: 'github',
            appRunContainmentAllowances: null,
            getRepoOwner: () => 'maya',
            getDataRepo: () => 'bookings-data',
            getWebsiteRepo: () => 'bookings',
        };

        function reads(sizeKb: number | null | Error): IsolatedRunAdmissionReads & {
            repositorySizeKb: jest.Mock;
        } {
            return {
                works: {
                    findById: jest.fn(async () => work),
                    casAppRunContainmentAllowances: jest.fn(async () => true),
                },
                fleet: {
                    nodesForUser: jest.fn(async () => []),
                    latestContainment: jest.fn(async () => null),
                },
                pushCredential: jest.fn(async () => true),
                cloudPipeline: jest.fn(async () => null),
                repositorySizeKb: jest.fn(async () => {
                    if (sizeKb instanceof Error) throw sizeKb;
                    return sizeKb;
                }),
            } as unknown as IsolatedRunAdmissionReads & { repositorySizeKb: jest.Mock };
        }

        const input = {
            task: { id: 't1', userId: OWNER, workId: APP_WORK },
            agent: { id: 'agent-1', userId: OWNER },
            placement: { placement: 'cloud' as const },
            work,
        };

        /** Enter a limit for the checkout stage for one case, the way FR-72's number will land. */
        function withCheckoutLimit<T>(maxSizeKb: number, run: () => Promise<T>): Promise<T> {
            const table = APP_REPOSITORY_STAGE_LIMITS as Record<
                AppRepositoryStage,
                { maxSizeKb?: number; refusalCodes: readonly string[] }
            >;
            const before = table[APP_WORK_RUN_CHECKOUT_STAGE];
            table[APP_WORK_RUN_CHECKOUT_STAGE] = { ...before, maxSizeKb };
            return run().finally(() => {
                table[APP_WORK_RUN_CHECKOUT_STAGE] = before;
            });
        }

        it('today (no limit for the checkout stage) the size is never read and nothing is refused for it', async () => {
            expect(appWorkRunStageSizeLimitKb()).toBeUndefined();
            const r = reads(99 * GIB_KB);
            const verdict = await new IsolatedRunAdmissionService(r).admit(input);
            expect(r.repositorySizeKb).not.toHaveBeenCalled();
            expect(verdict && isAppWorkRunRefusal(verdict) ? verdict.code : null).not.toBe(
                'repositoryTooLarge',
            );
        });

        it('with a limit entered in the table, an oversized repository is refused before placement is judged (S35)', async () => {
            const r = reads(4 * GIB_KB);
            const verdict = await withCheckoutLimit(3 * GIB_KB, () =>
                new IsolatedRunAdmissionService(r).admit(input),
            );
            expect(verdict).toMatchObject({
                code: 'repositoryTooLarge',
                stage: APP_WORK_RUN_CHECKOUT_STAGE,
                sizeKb: 4 * GIB_KB,
                maxSizeKb: 3 * GIB_KB,
            });
            expect(r.repositorySizeKb).toHaveBeenCalledWith(OWNER, 'maya', 'bookings', work);
            // Refused before the cloud pipeline (or any Fleet read) was asked.
            expect(r.cloudPipeline).not.toHaveBeenCalled();
        });

        it('with a limit, a repository inside it passes on to the placement rules', async () => {
            const r = reads(1 * GIB_KB);
            const verdict = await withCheckoutLimit(3 * GIB_KB, () =>
                new IsolatedRunAdmissionService(r).admit(input),
            );
            expect(verdict && isAppWorkRunRefusal(verdict) ? verdict.code : null).not.toBe(
                'repositoryTooLarge',
            );
            expect(r.cloudPipeline).toHaveBeenCalled();
        });

        it('with a limit, a size that cannot be read is refused (fail closed)', async () => {
            const r = reads(new Error('provider down'));
            const verdict = await withCheckoutLimit(3 * GIB_KB, () =>
                new IsolatedRunAdmissionService(r).admit(input),
            );
            expect(verdict).toMatchObject({ code: 'repositoryTooLarge', sizeKb: null });
        });
    });
});
