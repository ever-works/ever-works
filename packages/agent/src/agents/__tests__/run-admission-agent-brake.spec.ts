import {
    agentBrakeAdmission,
    composeRunAdmission,
    DEFAULT_RUN_ADMISSION_CHAIN,
    QUEUED_REASON_AGENT_PAUSED,
    QUEUED_REASON_CONCURRENCY,
    RUN_ADMISSION_ADMITTED,
    type RunAdmissionContext,
} from '../run-admission-chain';

/**
 * AW-23 — the AGENT BRAKE middleware.
 *
 * The behaviour under test is the whole point of the epic: until now
 * `Pause` bound on exactly one dispatch path, so assigning a task to a
 * paused agent ran it. These cases pin the four things that make the
 * brake real — it parks, it fails CLOSED, it stays invisible when
 * unbound, and it sits BEFORE the concurrency valves so a paused agent
 * never consumes a slot's worth of counting.
 */
describe('agent brake admission (AW-23)', () => {
    const makeContext = (over: Partial<RunAdmissionContext> = {}): RunAdmissionContext =>
        ({
            input: { userId: 'user-1', workId: 'work-1', organizationId: null, agentId: 'agent-1' },
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
        }) as unknown as RunAdmissionContext;

    const next = jest.fn().mockResolvedValue(RUN_ADMISSION_ADMITTED);

    beforeEach(() => next.mockClear());

    it('parks the run with `agent-paused` when the agent is halted', async () => {
        const agentBrake = {
            shouldHaltForAgent: jest.fn().mockResolvedValue({ halted: true, reason: 'user' }),
        };
        await expect(agentBrakeAdmission(makeContext({ agentBrake }), next)).resolves.toEqual({
            admitted: false,
            queuedReason: QUEUED_REASON_AGENT_PAUSED,
        });
        expect(agentBrake.shouldHaltForAgent).toHaveBeenCalledWith('agent-1');
        expect(next).not.toHaveBeenCalled();
    });

    it('passes an active agent straight through to the next middleware', async () => {
        const agentBrake = {
            shouldHaltForAgent: jest.fn().mockResolvedValue({ halted: false }),
        };
        await expect(agentBrakeAdmission(makeContext({ agentBrake }), next)).resolves.toEqual(
            RUN_ADMISSION_ADMITTED,
        );
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('passes everything through when the port is UNBOUND', async () => {
        // Unit tests and trimmed installs construct the gate without the
        // agent repository; the brake must be invisible there, exactly
        // like the global stop flag.
        await expect(agentBrakeAdmission(makeContext(), next)).resolves.toEqual(
            RUN_ADMISSION_ADMITTED,
        );
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('skips the brake for a run that names no agent', async () => {
        const agentBrake = { shouldHaltForAgent: jest.fn() };
        await expect(
            agentBrakeAdmission(
                makeContext({
                    agentBrake,
                    input: { userId: 'user-1', workId: 'work-1', agentId: null },
                } as Partial<RunAdmissionContext>),
                next,
            ),
        ).resolves.toEqual(RUN_ADMISSION_ADMITTED);
        expect(agentBrake.shouldHaltForAgent).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED: a throwing brake parks the run instead of admitting it', async () => {
        // The gate swallows a throwing chain and admits. So an unreadable
        // brake has to become a PARK verdict right here, or a pause would
        // let work through at the one moment it matters most.
        const agentBrake = {
            shouldHaltForAgent: jest.fn().mockRejectedValue(new Error('db down')),
        };
        const context = makeContext({ agentBrake });
        await expect(agentBrakeAdmission(context, next)).resolves.toEqual({
            admitted: false,
            queuedReason: QUEUED_REASON_AGENT_PAUSED,
        });
        expect(next).not.toHaveBeenCalled();
        expect(context.logger.warn).toHaveBeenCalled();
    });

    it('never leaks the halt reason into the park reason', async () => {
        // Held work always reads "the agent is paused", whatever the
        // stored reason was — the reason belongs on the card, not on the
        // queued row every drain matches on.
        const agentBrake = {
            shouldHaltForAgent: jest.fn().mockResolvedValue({ halted: true, reason: 'credential' }),
        };
        const verdict = await agentBrakeAdmission(makeContext({ agentBrake }), next);
        expect(verdict.queuedReason).toBe(QUEUED_REASON_AGENT_PAUSED);
    });

    describe('position in DEFAULT_RUN_ADMISSION_CHAIN', () => {
        it('sits second — after the stop flag, before the Work valve', () => {
            expect(DEFAULT_RUN_ADMISSION_CHAIN[1]).toBe(agentBrakeAdmission);
        });

        it('parks a paused agent WITHOUT spending a concurrency count', async () => {
            const agentBrake = {
                shouldHaltForAgent: jest.fn().mockResolvedValue({ halted: true }),
            };
            const context = makeContext({ agentBrake });
            // Saturated Work: were the valve to run first this would park
            // with `concurrency-limit`, and the ordinary terminal-transition
            // drain would release it while the agent is still paused.
            (context.counters.countInFlightForWork as jest.Mock).mockResolvedValue(10);

            await expect(
                composeRunAdmission(DEFAULT_RUN_ADMISSION_CHAIN)(context),
            ).resolves.toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_AGENT_PAUSED,
            });
            expect(context.counters.countInFlightForWork).not.toHaveBeenCalled();
        });

        it('still lets the Work valve park an ACTIVE agent as `concurrency-limit`', async () => {
            const agentBrake = {
                shouldHaltForAgent: jest.fn().mockResolvedValue({ halted: false }),
            };
            const context = makeContext({ agentBrake });
            (context.counters.countInFlightForWork as jest.Mock).mockResolvedValue(10);
            await expect(
                composeRunAdmission(DEFAULT_RUN_ADMISSION_CHAIN)(context),
            ).resolves.toEqual({
                admitted: false,
                queuedReason: QUEUED_REASON_CONCURRENCY,
            });
        });
    });
});
