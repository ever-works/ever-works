import {
    composeRunAdmission,
    DEFAULT_RUN_ADMISSION_CHAIN,
    killSwitchAdmission,
    QUEUED_REASON_CONCURRENCY,
    QUEUED_REASON_KILL_SWITCH,
    RUN_ADMISSION_ADMITTED,
    type RunAdmissionContext,
} from '../run-admission-chain';

/**
 * Panic controls (EW-778) — the GLOBAL STOP FLAG as the FIRST admission
 * middleware.
 *
 * Three properties, each of which would silently reopen the hole if
 * lost:
 *   1. it is index 0 of the shipped chain, so a stopped platform parks
 *      before any counter is consulted;
 *   2. a port that THROWS parks the run (fail-closed) — `admit()` swallows
 *      a throwing chain and ADMITS, so the conversion has to happen here;
 *   3. an absent port is a pass-through, so fleet-less installs and every
 *      existing unit test are untouched.
 */
describe('run admission chain — kill switch (EW-778)', () => {
    const counters = () => ({
        countInFlightForWork: jest.fn().mockResolvedValue(0),
        countInFlightForOrganization: jest.fn().mockResolvedValue(0),
        countInFlightForUser: jest.fn().mockResolvedValue(0),
    });

    const makeContext = (over: Partial<RunAdmissionContext> = {}): RunAdmissionContext => ({
        input: { userId: 'user-1', workId: 'work-1', organizationId: null },
        counters: counters(),
        logger: { log: jest.fn(), warn: jest.fn() },
        resolveWorkLimit: () => 10,
        resolveOrgLimit: () => 25,
        isCreditsEnforcementEnabled: () => false,
        isPlanConcurrencyEnabled: () => false,
        ...over,
    });

    it('is the FIRST middleware of the shipped chain', () => {
        expect(DEFAULT_RUN_ADMISSION_CHAIN[0]).toBe(killSwitchAdmission);
    });

    it('passes through when no port is bound', async () => {
        const next = jest.fn(async () => RUN_ADMISSION_ADMITTED);
        await expect(killSwitchAdmission(makeContext(), next)).resolves.toEqual(
            RUN_ADMISSION_ADMITTED,
        );
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('passes through when the flag is clear', async () => {
        const next = jest.fn(async () => RUN_ADMISSION_ADMITTED);
        const context = makeContext({
            killSwitch: { shouldHaltDispatch: jest.fn().mockResolvedValue(false) },
        });
        await expect(killSwitchAdmission(context, next)).resolves.toEqual(RUN_ADMISSION_ADMITTED);
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('parks with `kill-switch` when the flag is set, without calling next()', async () => {
        const next = jest.fn(async () => RUN_ADMISSION_ADMITTED);
        const context = makeContext({
            killSwitch: { shouldHaltDispatch: jest.fn().mockResolvedValue(true) },
        });
        await expect(killSwitchAdmission(context, next)).resolves.toEqual({
            admitted: false,
            queuedReason: QUEUED_REASON_KILL_SWITCH,
        });
        expect(next).not.toHaveBeenCalled();
    });

    /**
     * THE load-bearing test. `RunDispatchGateService.admit()` turns a
     * throwing chain into `{ admitted: true }`. Revert-check: remove the
     * try/catch in `killSwitchAdmission` and this goes RED.
     */
    it('parks (fail-closed) when the port THROWS, and never propagates', async () => {
        const next = jest.fn(async () => RUN_ADMISSION_ADMITTED);
        const context = makeContext({
            killSwitch: { shouldHaltDispatch: jest.fn().mockRejectedValue(new Error('db down')) },
        });
        await expect(killSwitchAdmission(context, next)).resolves.toEqual({
            admitted: false,
            queuedReason: QUEUED_REASON_KILL_SWITCH,
        });
        expect(next).not.toHaveBeenCalled();
        expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('fail-closed'));
    });

    it('through the shipped chain: a stopped platform parks before ANY counter is consulted', async () => {
        const context = makeContext({
            killSwitch: { shouldHaltDispatch: jest.fn().mockResolvedValue(true) },
        });
        const verdict = await composeRunAdmission(DEFAULT_RUN_ADMISSION_CHAIN)(context);
        expect(verdict).toEqual({ admitted: false, queuedReason: QUEUED_REASON_KILL_SWITCH });
        expect(context.counters.countInFlightForWork).not.toHaveBeenCalled();
        expect(context.counters.countInFlightForOrganization).not.toHaveBeenCalled();
        expect(context.counters.countInFlightForUser).not.toHaveBeenCalled();
    });

    it('through the shipped chain: a clear flag hands over to the concurrency valves', async () => {
        const context = makeContext({
            killSwitch: { shouldHaltDispatch: jest.fn().mockResolvedValue(false) },
            counters: {
                ...counters(),
                countInFlightForWork: jest.fn().mockResolvedValue(10),
            },
        });
        const verdict = await composeRunAdmission(DEFAULT_RUN_ADMISSION_CHAIN)(context);
        expect(verdict).toEqual({ admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY });
    });
});
