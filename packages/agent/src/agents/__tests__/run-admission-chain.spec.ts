import {
    composeRunAdmission,
    creditsAdmission,
    orgConcurrencyAdmission,
    workConcurrencyAdmission,
    DEFAULT_RUN_ADMISSION_CHAIN,
    QUEUED_REASON_CONCURRENCY,
    QUEUED_REASON_INSUFFICIENT_CREDITS,
    RUN_ADMISSION_ADMITTED,
    type RunAdmissionContext,
    type RunAdmissionMiddleware,
} from '../run-admission-chain';

/**
 * Judgment layer G15 — the pre-run path as a composed middleware chain.
 *
 * These tests pin the CHAIN mechanics (order, short-circuiting,
 * next()-once, extensibility) plus each middleware in isolation. The
 * "behaviour is unchanged" half is proven end-to-end by the existing
 * `run-dispatch-gate.service.spec.ts` admit() suite, which still passes
 * against the refactored gate untouched.
 */
describe('run admission chain', () => {
    const makeContext = (over: Partial<RunAdmissionContext> = {}): RunAdmissionContext => ({
        input: { userId: 'user-1', workId: 'work-1', organizationId: null },
        counters: {
            countInFlightForWork: jest.fn().mockResolvedValue(0),
            countInFlightForOrganization: jest.fn().mockResolvedValue(0),
            countInFlightForUser: jest.fn().mockResolvedValue(0),
        },
        logger: { log: jest.fn(), warn: jest.fn() },
        resolveWorkLimit: () => 10,
        resolveOrgLimit: () => 25,
        isCreditsEnforcementEnabled: () => false,
        ...over,
    });

    describe('composeRunAdmission', () => {
        it('admits when every middleware calls next()', async () => {
            const order: string[] = [];
            const step =
                (name: string): RunAdmissionMiddleware =>
                async (_ctx, next) => {
                    order.push(name);
                    return next();
                };
            const run = composeRunAdmission([step('a'), step('b'), step('c')]);
            await expect(run(makeContext())).resolves.toEqual(RUN_ADMISSION_ADMITTED);
            expect(order).toEqual(['a', 'b', 'c']);
        });

        it('short-circuits at the first middleware that returns a verdict', async () => {
            const later = jest.fn();
            const run = composeRunAdmission([
                async () => ({ admitted: false, queuedReason: 'stop-here' }),
                async (_ctx, next) => {
                    later();
                    return next();
                },
            ]);
            await expect(run(makeContext())).resolves.toEqual({
                admitted: false,
                queuedReason: 'stop-here',
            });
            expect(later).not.toHaveBeenCalled();
        });

        it('admits an empty chain', async () => {
            await expect(composeRunAdmission([])(makeContext())).resolves.toEqual(
                RUN_ADMISSION_ADMITTED,
            );
        });

        it('refuses a middleware that calls next() twice — double-counting is a real bug', async () => {
            const run = composeRunAdmission([
                async (_ctx, next) => {
                    await next();
                    return next();
                },
            ]);
            await expect(run(makeContext())).rejects.toThrow(/more than once/);
        });

        it('composes a NEW policy without touching any existing middleware', async () => {
            const maintenanceWindow: RunAdmissionMiddleware = async () => ({
                admitted: false,
                queuedReason: 'maintenance',
            });
            const run = composeRunAdmission([maintenanceWindow, ...DEFAULT_RUN_ADMISSION_CHAIN]);
            const context = makeContext();
            await expect(run(context)).resolves.toEqual({
                admitted: false,
                queuedReason: 'maintenance',
            });
            expect(context.counters.countInFlightForWork).not.toHaveBeenCalled();
        });
    });

    describe('workConcurrencyAdmission', () => {
        it('admits under the limit', async () => {
            const context = makeContext();
            (context.counters.countInFlightForWork as jest.Mock).mockResolvedValue(9);
            const run = composeRunAdmission([workConcurrencyAdmission]);
            await expect(run(context)).resolves.toEqual(RUN_ADMISSION_ADMITTED);
        });

        it('parks at/over the limit with the concurrency reason', async () => {
            const context = makeContext();
            (context.counters.countInFlightForWork as jest.Mock).mockResolvedValue(10);
            const run = composeRunAdmission([workConcurrencyAdmission]);
            await expect(run(context)).resolves.toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });
        });

        it('skips the count entirely for a Work-less run or a disabled valve', async () => {
            const noWork = makeContext({ input: { userId: 'user-1', workId: null } });
            await composeRunAdmission([workConcurrencyAdmission])(noWork);
            expect(noWork.counters.countInFlightForWork).not.toHaveBeenCalled();

            const disabled = makeContext({ resolveWorkLimit: () => 0 });
            await composeRunAdmission([workConcurrencyAdmission])(disabled);
            expect(disabled.counters.countInFlightForWork).not.toHaveBeenCalled();
        });
    });

    describe('orgConcurrencyAdmission', () => {
        it('counts per-org when an organizationId is present, per-user otherwise', async () => {
            const withOrg = makeContext({
                input: { userId: 'user-1', workId: null, organizationId: 'org-1' },
            });
            await composeRunAdmission([orgConcurrencyAdmission])(withOrg);
            expect(withOrg.counters.countInFlightForOrganization).toHaveBeenCalledWith('org-1');
            expect(withOrg.counters.countInFlightForUser).not.toHaveBeenCalled();

            const withoutOrg = makeContext({ input: { userId: 'user-1', workId: null } });
            await composeRunAdmission([orgConcurrencyAdmission])(withoutOrg);
            expect(withoutOrg.counters.countInFlightForUser).toHaveBeenCalledWith('user-1');
        });

        it('parks over the valve', async () => {
            const context = makeContext();
            (context.counters.countInFlightForUser as jest.Mock).mockResolvedValue(25);
            await expect(composeRunAdmission([orgConcurrencyAdmission])(context)).resolves.toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });
        });
    });

    describe('creditsAdmission', () => {
        it('is dark unless the kill-switch is on', async () => {
            const precheck = { shouldQueueForCredits: jest.fn().mockResolvedValue(true) };
            const context = makeContext({ creditsPrecheck: precheck });
            await expect(composeRunAdmission([creditsAdmission])(context)).resolves.toEqual(
                RUN_ADMISSION_ADMITTED,
            );
            expect(precheck.shouldQueueForCredits).not.toHaveBeenCalled();
        });

        it('parks a broke user when enabled', async () => {
            const precheck = { shouldQueueForCredits: jest.fn().mockResolvedValue(true) };
            const context = makeContext({
                creditsPrecheck: precheck,
                isCreditsEnforcementEnabled: () => true,
            });
            await expect(composeRunAdmission([creditsAdmission])(context)).resolves.toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_INSUFFICIENT_CREDITS,
            });
        });

        it('fails OPEN when the precheck throws', async () => {
            const precheck = {
                shouldQueueForCredits: jest.fn().mockRejectedValue(new Error('billing down')),
            };
            const context = makeContext({
                creditsPrecheck: precheck,
                isCreditsEnforcementEnabled: () => true,
            });
            await expect(composeRunAdmission([creditsAdmission])(context)).resolves.toEqual(
                RUN_ADMISSION_ADMITTED,
            );
            expect(context.logger.warn).toHaveBeenCalled();
        });
    });

    describe('DEFAULT_RUN_ADMISSION_CHAIN', () => {
        it('is the shipped order: Work valve, org/user valve, credits', () => {
            expect(DEFAULT_RUN_ADMISSION_CHAIN).toEqual([
                workConcurrencyAdmission,
                orgConcurrencyAdmission,
                creditsAdmission,
            ]);
        });

        it('lets the concurrency valve win over the credits precheck', async () => {
            const precheck = { shouldQueueForCredits: jest.fn().mockResolvedValue(true) };
            const context = makeContext({
                creditsPrecheck: precheck,
                isCreditsEnforcementEnabled: () => true,
            });
            (context.counters.countInFlightForWork as jest.Mock).mockResolvedValue(10);
            await expect(
                composeRunAdmission(DEFAULT_RUN_ADMISSION_CHAIN)(context),
            ).resolves.toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });
            expect(precheck.shouldQueueForCredits).not.toHaveBeenCalled();
        });
    });
});
