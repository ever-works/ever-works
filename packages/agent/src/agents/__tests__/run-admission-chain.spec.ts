import {
    composeRunAdmission,
    creditsAdmission,
    killSwitchAdmission,
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
        isPlanConcurrencyEnabled: () => false,
        ...over,
    });

    /**
     * H2 — the plan's `max-concurrent-runs` entitlement, folded into the org
     * valve as a RAISE-ONLY adjustment.
     *
     * The whole safety argument is "this can never park a run that would not
     * already have parked", so the tests that matter are the ones that would
     * go red if it ever gained the power to LOWER a ceiling.
     */
    describe('plan concurrency (raise-only)', () => {
        const planCtx = (planLimit: number | null, over: Partial<RunAdmissionContext> = {}) =>
            makeContext({
                isPlanConcurrencyEnabled: () => true,
                planLimits: { resolveConcurrencyLimit: jest.fn().mockResolvedValue(planLimit) },
                ...over,
            });

        /**
         * 🛑 THE load-bearing test. `free` is seeded at 3 and the enforced
         * status quo is the env valve at 25. If the plan value were ever
         * allowed to win, giving this entitlement its first reader would cut
         * every existing user from 25 to 3 on the first deploy — and park runs
         * that nothing can drain, because the drain is Work-keyed.
         *
         * Revert-check: change `Math.max(envLimit, planLimit)` to `planLimit`
         * and this must go RED.
         */
        it('never LOWERS the env ceiling', async () => {
            const context = planCtx(3, {
                resolveOrgLimit: () => 25,
                counters: {
                    countInFlightForWork: jest.fn().mockResolvedValue(0),
                    countInFlightForOrganization: jest.fn().mockResolvedValue(0),
                    // Above the plan value of 3, below the env value of 25.
                    countInFlightForUser: jest.fn().mockResolvedValue(10),
                },
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            expect(verdict).toEqual(RUN_ADMISSION_ADMITTED);
        });

        it('RAISES the ceiling when the plan allows more than the env default', async () => {
            const context = planCtx(40, {
                resolveOrgLimit: () => 25,
                counters: {
                    countInFlightForWork: jest.fn().mockResolvedValue(0),
                    countInFlightForOrganization: jest.fn().mockResolvedValue(0),
                    countInFlightForUser: jest.fn().mockResolvedValue(30),
                },
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            expect(verdict).toEqual(RUN_ADMISSION_ADMITTED);
        });

        /**
         * "Unlimited" is stored as `-1`. It EXEMPTS the buyer from the env valve;
         * it does not switch the valve off before it has been evaluated. The
         * distinction matters because the exemption is conditional (below).
         */
        it('exempts an unlimited plan from a saturated env valve', async () => {
            const counters = {
                countInFlightForWork: jest.fn().mockResolvedValue(0),
                countInFlightForOrganization: jest.fn().mockResolvedValue(9999),
                countInFlightForUser: jest.fn().mockResolvedValue(9999),
            };
            const context = planCtx(-1, {
                input: { userId: 'user-1', workId: 'work-1', organizationId: null },
                resolveOrgLimit: () => 25,
                resolveWorkLimit: () => 10,
                counters,
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            expect(verdict).toEqual(RUN_ADMISSION_ADMITTED);
        });

        /**
         * 🛑 BOTH halves of the bypass condition are load-bearing.
         *
         * `workConcurrencyAdmission` returns next() when EITHER there is no workId
         * OR its own limit is `<= 0` — and a Work limit of 0 is a supported way to
         * disable that valve. Checking only for a workId therefore let an unlimited
         * plan plus `AGENT_MAX_CONCURRENT_RUNS_PER_WORK=0` bypass every valve in
         * the chain at once, with nothing bounding the user anywhere.
         *
         * Revert-check: drop `&& context.resolveWorkLimit() > 0` and this goes RED.
         */
        it('does NOT exempt an unlimited plan when the Work valve is itself disabled', async () => {
            const counters = {
                countInFlightForWork: jest.fn().mockResolvedValue(0),
                countInFlightForOrganization: jest.fn().mockResolvedValue(9999),
                countInFlightForUser: jest.fn().mockResolvedValue(9999),
            };
            const context = planCtx(-1, {
                input: { userId: 'user-1', workId: 'work-1', organizationId: null },
                resolveOrgLimit: () => 25,
                resolveWorkLimit: () => 0,
                counters,
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            expect(verdict).toEqual({ admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY });
        });

        it('does NOT exempt an unlimited plan on a Work-LESS run', async () => {
            const counters = {
                countInFlightForWork: jest.fn().mockResolvedValue(0),
                countInFlightForOrganization: jest.fn().mockResolvedValue(9999),
                countInFlightForUser: jest.fn().mockResolvedValue(9999),
            };
            const context = planCtx(-1, {
                input: { userId: 'user-1', workId: null, organizationId: null },
                resolveOrgLimit: () => 25,
                resolveWorkLimit: () => 10,
                counters,
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            expect(verdict).toEqual({ admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY });
        });

        /**
         * 🛑 THE ENTITLEMENT IS PER-USER, SO IT MUST BE MEASURED PER-USER.
         *
         * Subscriptions hang off `userId`; `Organization` carries no plan at all.
         * Applying one member's allowance to the ORG counter raised the ceiling for
         * everyone in the org — handing out capacity nobody bought, and letting
         * colleagues consume the allowance the buyer paid for.
         *
         * Here the org is saturated (30 of 25) but the buyer holds only 2 of their
         * own 10. They should run; their colleagues should not.
         *
         * Revert-check: measure the plan against the org count and this goes RED.
         */
        it('measures the plan allowance against the BUYER, not the org', async () => {
            const counters = {
                countInFlightForWork: jest.fn().mockResolvedValue(0),
                countInFlightForOrganization: jest.fn().mockResolvedValue(30),
                countInFlightForUser: jest.fn().mockResolvedValue(2),
            };
            const context = planCtx(10, {
                input: { userId: 'buyer', workId: 'work-1', organizationId: 'org-1' },
                resolveOrgLimit: () => 25,
                counters,
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            expect(verdict).toEqual(RUN_ADMISSION_ADMITTED);
            expect(counters.countInFlightForUser).toHaveBeenCalledWith('buyer');
        });

        it('parks a buyer who has exhausted their OWN allowance, even in a quiet org', async () => {
            const counters = {
                countInFlightForWork: jest.fn().mockResolvedValue(0),
                countInFlightForOrganization: jest.fn().mockResolvedValue(30),
                countInFlightForUser: jest.fn().mockResolvedValue(10),
            };
            const context = planCtx(10, {
                input: { userId: 'buyer', workId: 'work-1', organizationId: 'org-1' },
                resolveOrgLimit: () => 25,
                counters,
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            expect(verdict).toEqual({ admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY });
        });

        it("does not spend a second query when the env count is already the user's", async () => {
            // Outside an org the env valve counts the user, so the plan check has
            // the number it needs already.
            const counters = {
                countInFlightForWork: jest.fn().mockResolvedValue(0),
                countInFlightForOrganization: jest.fn().mockResolvedValue(0),
                countInFlightForUser: jest.fn().mockResolvedValue(26),
            };
            const context = planCtx(40, {
                input: { userId: 'user-1', workId: 'work-1', organizationId: null },
                resolveOrgLimit: () => 25,
                counters,
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            expect(verdict).toEqual(RUN_ADMISSION_ADMITTED);
            expect(counters.countInFlightForUser).toHaveBeenCalledTimes(1);
        });

        it('keeps the env ceiling when the lookup throws (fail-open)', async () => {
            const context = makeContext({
                isPlanConcurrencyEnabled: () => true,
                planLimits: {
                    resolveConcurrencyLimit: jest.fn().mockRejectedValue(new Error('billing down')),
                },
                resolveOrgLimit: () => 25,
                counters: {
                    countInFlightForWork: jest.fn().mockResolvedValue(0),
                    countInFlightForOrganization: jest.fn().mockResolvedValue(0),
                    countInFlightForUser: jest.fn().mockResolvedValue(25),
                },
            });

            const verdict = await orgConcurrencyAdmission(
                context,
                async () => RUN_ADMISSION_ADMITTED,
            );

            // The env valve still applies — fail-open means "ignore the plan",
            // not "admit everything".
            expect(verdict).toEqual({ admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY });
        });

        it('does not consult the plan at all when the kill-switch is off', async () => {
            const resolveConcurrencyLimit = jest.fn().mockResolvedValue(3);
            const context = makeContext({
                isPlanConcurrencyEnabled: () => false,
                planLimits: { resolveConcurrencyLimit },
            });

            await orgConcurrencyAdmission(context, async () => RUN_ADMISSION_ADMITTED);

            expect(resolveConcurrencyLimit).not.toHaveBeenCalled();
        });
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
        // EW-778 — the global stop flag leads the chain (fail-closed, and
        // before any counter is spent); below it the order is unchanged.
        it('is the shipped order: stop flag, Work valve, org/user valve, credits', () => {
            expect(DEFAULT_RUN_ADMISSION_CHAIN).toEqual([
                killSwitchAdmission,
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
