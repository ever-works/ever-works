import { totalCostCents } from '@ever-works/contracts';

import { BudgetGuardService } from '../../budgets/budget-guard.service';
import { BudgetService } from '../../budgets/budget.service';
import { BudgetThresholdCrossedEvent } from '../../budgets/budget-threshold-crossed.event';
import { PluginUsageCapability } from '../../entities/plugin-usage-event.entity';
import { WorkBudgetScope, type WorkBudget } from '../../entities/work-budget.entity';
import {
    DEFAULT_RUN_ADMISSION_CHAIN,
    QUEUED_REASON_AGENT_PAUSED,
    QUEUED_REASON_CONCURRENCY,
    QUEUED_REASON_KILL_SWITCH,
    QUEUED_REASON_WORK_BUDGET,
    agentBrakeAdmission,
    composeRunAdmission,
    createWorkBudgetAdmission,
    creditsAdmission,
    killSwitchAdmission,
    orgConcurrencyAdmission,
    withWorkBudgetAdmission,
    workConcurrencyAdmission,
    type RunAdmissionContext,
    type RunAdmissionInput,
} from '../../agents/run-admission-chain';
import { RunDispatchGateService } from '../../agents/run-dispatch-gate.service';
import { AgentRunSweeperService } from '../../agents/agent-run-sweeper.service';
import {
    UPSTREAM_CONTRIBUTION_CAPABILITY,
    UPSTREAM_CONTRIBUTION_PLUGIN_ID,
} from '../../upstream-pull-requests/upstream-contribution-budget.service';
import {
    APP_WORK_BUDGET_WAIT,
    APP_WORK_BUILD_PLUGIN_ID,
    APP_WORK_CHARGE_BOOKING,
    APP_WORK_CHARGE_KINDS,
    APP_WORK_RUN_PLUGIN_ID,
    AppWorkBudgetAdmissionInstaller,
    AppWorkBudgetService,
    totalAppWorkCharges,
    type AppWorkBudgetWait,
} from '../app-work-budget';

/**
 * APW-08 T56 (XC-19, FR-73, FR-66, ACC-08-37) — one budget per App Work.
 *
 * Every App Work charge books against THAT Work's own `WorkBudget` through the platform's
 * `BudgetGuardService` (no new spend account); the guard's alert fires once per threshold and
 * period; a run the budget refuses is PARKED (`work-budget`) — a wait, never a failure, and it
 * opens no follow-up because it never reaches a runtime; and unknown amounts total as unknown.
 * Every other Work kind is admitted exactly as before.
 */

const NOW = new Date('2026-10-15T12:00:00Z');
const APP = 'work-app';
const DIRECTORY = 'work-directory';
const AGENT_WORK = 'work-of-the-agent';

const WORKS: Record<string, { id: string; kind: string }> = {
    [APP]: { id: APP, kind: 'app' },
    [DIRECTORY]: { id: DIRECTORY, kind: 'directory' },
    [AGENT_WORK]: { id: AGENT_WORK, kind: 'repo' },
};

function worksRepo() {
    return {
        findOne: jest.fn(async ({ where }: { where: { id: string } }) => WORKS[where.id] ?? null),
    };
}

function globalBudget(workId: string, over: Partial<WorkBudget> = {}): WorkBudget {
    return {
        id: `budget-${workId}`,
        workId,
        scope: WorkBudgetScope.GLOBAL,
        pluginId: null,
        monthlyCapCents: 10_000,
        currency: 'usd',
        allowOverage: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        work: undefined as never,
        ...over,
    } as WorkBudget;
}

/**
 * The REAL guard over the REAL budget service, with the two repositories and the alert-state
 * store as doubles. The alert store keeps the unique index's semantics: one insert per
 * (budget, threshold, period), every later attempt answers `inserted: false`.
 */
function realGuard(opts: { spend?: number; budgets?: Record<string, WorkBudget | null> } = {}) {
    const state = { spend: opts.spend ?? 0 };
    const budgets = opts.budgets ?? {
        [APP]: globalBudget(APP),
        [DIRECTORY]: globalBudget(DIRECTORY),
    };
    const budgetRepo = {
        findGlobal: jest.fn(async (workId: string) => budgets[workId] ?? null),
        findForPlugin: jest.fn(async () => null),
    };
    const usageRepo = {
        getTotalSpendCents: jest.fn(async () => state.spend),
    };
    const recorded = new Set<string>();
    const alertState = {
        record: jest.fn(
            async (workId: string, budgetId: string, threshold: unknown, start: Date) => {
                const key = `${workId}:${budgetId}:${String(threshold)}:${start.toISOString()}`;
                if (recorded.has(key)) return { inserted: false };
                recorded.add(key);
                return { inserted: true };
            },
        ),
    };
    const events = { emit: jest.fn() };
    const budgetService = new BudgetService(budgetRepo as never, usageRepo as never);
    const guard = new BudgetGuardService(budgetService, alertState as never, events as never);
    const works = worksRepo();
    const service = new AppWorkBudgetService(guard, budgetService, works as never);
    return {
        service,
        guard,
        budgetService,
        budgetRepo,
        usageRepo,
        alertState,
        events,
        works,
        state,
    };
}

/** A context for the chain, every valve configured but quiet unless a test says otherwise. */
function context(
    input: RunAdmissionInput,
    over: Partial<RunAdmissionContext> = {},
): RunAdmissionContext {
    return {
        input,
        counters: {
            countInFlightForWork: jest.fn(async () => 0),
            countInFlightForOrganization: jest.fn(async () => 0),
            countInFlightForUser: jest.fn(async () => 0),
        },
        logger: { log: () => undefined, warn: () => undefined },
        resolveWorkLimit: () => 10,
        resolveOrgLimit: () => 25,
        isCreditsEnforcementEnabled: () => false,
        isPlanConcurrencyEnabled: () => false,
        killSwitch: { shouldHaltDispatch: jest.fn(async () => false) } as never,
        agentBrake: { shouldHaltForAgent: jest.fn(async () => ({ halted: false })) } as never,
        ...over,
    };
}

function waitOf(decision: unknown): AppWorkBudgetWait {
    return (decision as { wait: AppWorkBudgetWait }).wait;
}

describe('every charge type books against the App Work’s OWN budget', () => {
    it.each(APP_WORK_CHARGE_KINDS)(
        '`%s` goes through BudgetGuardService with the App Work id',
        async (charge) => {
            const guard = { checkBudget: jest.fn(async () => undefined) };
            const service = new AppWorkBudgetService(
                guard as never,
                undefined,
                worksRepo() as never,
            );

            const decision = await service.book({ workId: APP, userId: 'u-1', charge, now: NOW });

            expect(decision).toEqual({ allowed: true, gate: 'passed' });
            expect(guard.checkBudget).toHaveBeenCalledTimes(1);
            expect(guard.checkBudget).toHaveBeenCalledWith(
                APP,
                'u-1',
                APP_WORK_CHARGE_BOOKING[charge].capability,
                APP_WORK_CHARGE_BOOKING[charge].pluginId,
                { estimatedCostCents: 0, now: NOW },
            );
        },
    );

    it('names what each charge is for: AI for a run, BUILD for a managed Build, APW-09’s pair for a preparation run', () => {
        expect(APP_WORK_CHARGE_BOOKING.run).toEqual({
            capability: PluginUsageCapability.AI,
            pluginId: APP_WORK_RUN_PLUGIN_ID,
        });
        expect(APP_WORK_CHARGE_BOOKING.build).toEqual({
            capability: PluginUsageCapability.BUILD,
            pluginId: APP_WORK_BUILD_PLUGIN_ID,
        });
        // One booking for a contribution run, whichever door asks (APW-09 T44's own constants).
        expect(APP_WORK_CHARGE_BOOKING.preparation).toEqual({
            capability: UPSTREAM_CONTRIBUTION_CAPABILITY,
            pluginId: UPSTREAM_CONTRIBUTION_PLUGIN_ID,
        });
    });

    it('reads the App Work’s global WorkBudget — never the Agent’s Work, never a second account', async () => {
        const { service, budgetRepo, usageRepo } = realGuard({ spend: 100 });

        // A run of a Task on the App Work, by an Agent scoped to another Work.
        await service.shouldParkForWorkBudget({ userId: 'u-1', workId: APP, agentId: 'a-1' });

        expect(budgetRepo.findGlobal).toHaveBeenCalledWith(APP);
        expect(budgetRepo.findGlobal).not.toHaveBeenCalledWith(AGENT_WORK);
        expect(budgetRepo.findForPlugin).toHaveBeenCalledWith(APP, APP_WORK_RUN_PLUGIN_ID);
        // The spend is the one ledger's, for that Work, in the budget's currency.
        expect(usageRepo.getTotalSpendCents).toHaveBeenCalledWith(
            APP,
            expect.any(Date),
            expect.any(Date),
            undefined,
            'usd',
        );
    });

    it('every run dispatched for an App Work Task crosses the budget middleware', async () => {
        const { service } = realGuard({ spend: 100 });
        const ask = jest.spyOn(service, 'shouldParkForWorkBudget');
        const chain = composeRunAdmission(
            withWorkBudgetAdmission(DEFAULT_RUN_ADMISSION_CHAIN, service),
        );

        await expect(
            chain(context({ userId: 'u-1', workId: APP, agentId: 'a-1' })),
        ).resolves.toEqual({
            admitted: true,
        });
        expect(ask).toHaveBeenCalledWith({ userId: 'u-1', workId: APP, agentId: 'a-1' });
    });

    it('an installation with no budget layer is reported as ungated, not as a check that passed', async () => {
        const service = new AppWorkBudgetService(undefined, undefined, worksRepo() as never);
        await expect(service.book({ workId: APP, userId: 'u-1', charge: 'run' })).resolves.toEqual({
            allowed: true,
            gate: 'ungated',
        });
    });
});

describe('the alert threshold fires once', () => {
    it('one BudgetThresholdCrossedEvent per threshold and period, however many runs are admitted', async () => {
        const { service, events, state } = realGuard({ spend: 8_000 });

        for (let attempt = 0; attempt < 4; attempt += 1) {
            await service.book({ workId: APP, userId: 'u-1', charge: 'run', now: NOW });
        }

        expect(events.emit).toHaveBeenCalledTimes(1);
        const [name, event] = events.emit.mock.calls[0] as [string, BudgetThresholdCrossedEvent];
        expect(name).toBe(BudgetThresholdCrossedEvent.EVENT_NAME);
        expect(event).toBeInstanceOf(BudgetThresholdCrossedEvent);
        expect(event.workId).toBe(APP);

        // Spend climbs past the next threshold: that one fires once more, the first never again.
        state.spend = 9_200;
        await service.book({ workId: APP, userId: 'u-1', charge: 'run', now: NOW });
        await service.book({ workId: APP, userId: 'u-1', charge: 'build', now: NOW });
        expect(events.emit).toHaveBeenCalledTimes(2);
    });
});

describe('a refusal parks the run — a wait on FR-66’s terms — and opens no follow-up', () => {
    it('a spent budget is a WAIT with the period’s reset time, not an error', async () => {
        const { service } = realGuard({ spend: 10_000 });

        const decision = await service.book({
            workId: APP,
            userId: 'u-1',
            charge: 'run',
            now: NOW,
        });

        expect(decision.allowed).toBe(false);
        expect(waitOf(decision)).toEqual({
            waiting: APP_WORK_BUDGET_WAIT,
            queuedReason: QUEUED_REASON_WORK_BUDGET,
            charge: 'run',
            resetAt: '2026-11-01T00:00:00.000Z',
            resetAtMs: Date.parse('2026-11-01T00:00:00.000Z'),
            scope: WorkBudgetScope.GLOBAL,
            pluginId: null,
            currentSpendCents: 10_000,
            capCents: 10_000,
            currency: 'usd',
        });
    });

    it('the chain parks the run with `work-budget`', async () => {
        const { service } = realGuard({ spend: 10_000 });
        const chain = composeRunAdmission(
            withWorkBudgetAdmission(DEFAULT_RUN_ADMISSION_CHAIN, service),
        );

        await expect(chain(context({ userId: 'u-1', workId: APP }))).resolves.toEqual({
            admitted: false,
            queuedReason: QUEUED_REASON_WORK_BUDGET,
        });
    });

    function gateHarness(spend: number) {
        const guard = realGuard({ spend });
        // One run parked `work-budget` on the App Work, until a drain claims it.
        const parked = { open: true };
        const candidate = {
            id: 'run-parked',
            taskId: 'task-1',
            agentId: 'a-1',
            userId: 'u-1',
            workId: APP,
            organizationId: null,
            tenantId: null,
            triggerKind: 'task',
        };
        const runs = {
            countInFlightForWork: jest.fn(async () => 0),
            countInFlightForOrganization: jest.fn(async () => 0),
            countInFlightForUser: jest.fn(async () => 0),
            findOldestQueuedForConcurrency: jest.fn(async () => (parked.open ? candidate : null)),
            findQueuedWorkIdsByReason: jest.fn(async () => (parked.open ? [APP] : [])),
            claimQueuedForDispatch: jest.fn(async () => {
                parked.open = false;
                return true;
            }),
            setTriggerRunId: jest.fn(async () => undefined),
            relabelQueuedReason: jest.fn(async () => true),
            markFailed: jest.fn(),
            markDispatchFailed: jest.fn(),
        };
        const dispatcher = { enqueue: jest.fn(async () => ({ runId: 'trigger-1' })) };
        const gate = new RunDispatchGateService(runs as never, dispatcher as never);
        for (const level of ['log', 'warn'] as const) {
            jest.spyOn(
                (gate as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        new AppWorkBudgetAdmissionInstaller(gate, guard.service).onModuleInit();
        return { ...guard, gate, runs, dispatcher };
    }

    it('through the dispatch gate: the run row is created PARKED, never handed to a runtime, never failed', async () => {
        const { gate, runs, dispatcher } = gateHarness(10_000);
        const reserve = jest.fn(async () => undefined);

        const admission = await gate.admit({ userId: 'u-1', workId: APP, agentId: 'a-1' }, reserve);

        expect(admission).toEqual({ admitted: false, queuedReason: QUEUED_REASON_WORK_BUDGET });
        // The caller's reserve writes the `queued` row with this reason — that is what "parked" is.
        expect(reserve).toHaveBeenCalledWith({
            admitted: false,
            queuedReason: QUEUED_REASON_WORK_BUDGET,
        });
        // No runtime ⇒ no run executes ⇒ no gate attempt, no delivery state, and nothing that a
        // follow-up could ever be opened from (follow-ups open only from a failed Build/Deploy).
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
        expect(runs.markFailed).not.toHaveBeenCalled();
        expect(runs.markDispatchFailed).not.toHaveBeenCalled();
    });

    it('the booking door has no write path: nothing it depends on can open a follow-up or fail a Task', () => {
        // Its collaborators are the guard, the budget service and the Work's kind read — and
        // nothing else. A refusal cannot change anything even if a caller ignored it.
        expect(AppWorkBudgetService.length).toBe(3);
        const reflect = Reflect as unknown as {
            getMetadata?: (key: string, target: unknown) => unknown[] | undefined;
        };
        const paramTypes =
            typeof reflect.getMetadata === 'function'
                ? reflect.getMetadata('design:paramtypes', AppWorkBudgetService)
                : undefined;
        if (paramTypes) {
            expect(paramTypes.slice(0, 2)).toEqual([BudgetGuardService, BudgetService]);
        }
    });

    it('the sweeper never reaps a run parked on a budget — in the SQL and in the service', async () => {
        const runs = {
            findStuckNonTerminal: jest.fn(async () => [
                {
                    id: 'held',
                    agentId: 'a-1',
                    triggerKind: 'task',
                    status: 'queued',
                    startedAt: null,
                    createdAt: new Date(Date.now() - 48 * 60 * 60_000),
                    workId: APP,
                    awaitingInput: false,
                    queuedReason: QUEUED_REASON_WORK_BUDGET,
                },
            ]),
            markStuckFailed: jest.fn(async () => 0),
            parkStaleRunning: jest.fn(async () => 0),
        };
        const sweeper = new AgentRunSweeperService(runs as never);
        for (const level of ['log', 'warn'] as const) {
            jest.spyOn(
                (sweeper as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }

        const summary = await sweeper.sweepStuckRuns();

        expect(runs.findStuckNonTerminal).toHaveBeenCalledWith(
            expect.any(Date),
            expect.any(Number),
            expect.arrayContaining([QUEUED_REASON_WORK_BUDGET]),
        );
        expect(summary.swept).toBe(0);
        expect(runs.markStuckFailed).not.toHaveBeenCalled();
    });

    it('the sweeper’s tick releases it once the budget allows — and leaves it parked while it does not', async () => {
        const spent = gateHarness(10_000);
        const sweeper = new AgentRunSweeperService(
            { findStuckNonTerminal: jest.fn(async () => []) } as never,
            spent.gate,
        );
        jest.spyOn(
            (sweeper as never as { logger: Record<string, () => void> }).logger,
            'log',
        ).mockImplementation(() => undefined);

        await sweeper.sweepStuckRuns();
        // Re-admitted through the SAME chain: still spent ⇒ still parked, nothing dispatched.
        expect(spent.runs.findQueuedWorkIdsByReason).toHaveBeenCalledWith(
            QUEUED_REASON_WORK_BUDGET,
            expect.any(Number),
        );
        expect(spent.dispatcher.enqueue).not.toHaveBeenCalled();
        expect(spent.runs.claimQueuedForDispatch).not.toHaveBeenCalled();

        // A new period (or a raised cap): the same tick releases the parked run.
        spent.state.spend = 0;
        await sweeper.sweepStuckRuns();
        expect(spent.runs.claimQueuedForDispatch).toHaveBeenCalledWith(
            'run-parked',
            QUEUED_REASON_WORK_BUDGET,
        );
        expect(spent.dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ runId: 'run-parked' }),
        );
    });

    it('a release that throws never fails the sweep', async () => {
        const gate = { promoteParked: jest.fn(async () => Promise.reject(new Error('db down'))) };
        const sweeper = new AgentRunSweeperService(
            { findStuckNonTerminal: jest.fn(async () => []) } as never,
            gate as never,
        );
        for (const level of ['log', 'warn'] as const) {
            jest.spyOn(
                (sweeper as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        await expect(sweeper.sweepStuckRuns()).resolves.toMatchObject({ swept: 0 });
    });
});

describe('unknown amounts total as unknown (ACC-08-37)', () => {
    it('a known set sums; one unknown makes the whole total unknown; empty is a known zero', () => {
        expect(totalAppWorkCharges([1_200, 300, 0])).toBe(1_500);
        expect(totalAppWorkCharges([1_200, null, 300])).toBeNull();
        expect(totalAppWorkCharges([undefined])).toBeNull();
        expect(totalAppWorkCharges([Number.NaN])).toBeNull();
        expect(totalAppWorkCharges([Number.POSITIVE_INFINITY, 1])).toBeNull();
        expect(totalAppWorkCharges([])).toBe(0);
    });

    it('is the contracts’ one rule, so the API rollup and the web summary total the same way', () => {
        expect(totalAppWorkCharges).toBe(totalCostCents);
    });
});

describe('every other Work kind — and a run with no Work — is admitted exactly as before', () => {
    it('a non-App Work books nothing and reads no budget, even with a spent one', async () => {
        const { service, budgetRepo, usageRepo } = realGuard({ spend: 99_999 });

        await expect(
            service.book({ workId: DIRECTORY, userId: 'u-1', charge: 'run', now: NOW }),
        ).resolves.toEqual({ allowed: true, gate: 'not-app-work' });
        await expect(
            service.shouldParkForWorkBudget({ userId: 'u-1', workId: DIRECTORY }),
        ).resolves.toBe(false);
        expect(budgetRepo.findGlobal).not.toHaveBeenCalled();
        expect(usageRepo.getTotalSpendCents).not.toHaveBeenCalled();
    });

    it('a Work that no longer exists is not an App Work', async () => {
        const { service } = realGuard({ spend: 99_999 });
        await expect(
            service.book({ workId: 'gone', userId: 'u-1', charge: 'run' }),
        ).resolves.toEqual({
            allowed: true,
            gate: 'not-app-work',
        });
    });

    it('a run with no Work is never asked about', async () => {
        const port = { shouldParkForWorkBudget: jest.fn(async () => true) };
        const chain = composeRunAdmission(
            withWorkBudgetAdmission(DEFAULT_RUN_ADMISSION_CHAIN, port),
        );
        await expect(chain(context({ userId: 'u-1', workId: null }))).resolves.toEqual({
            admitted: true,
        });
        expect(port.shouldParkForWorkBudget).not.toHaveBeenCalled();
    });

    it('the installed chain answers exactly what the default chain answers for a non-App Work', async () => {
        const { service } = realGuard({ spend: 99_999 });
        const installed = composeRunAdmission(
            withWorkBudgetAdmission(DEFAULT_RUN_ADMISSION_CHAIN, service),
        );
        const shipped = composeRunAdmission(DEFAULT_RUN_ADMISSION_CHAIN);
        const input = { userId: 'u-1', workId: DIRECTORY, agentId: 'a-1' };
        const cases: Array<Partial<RunAdmissionContext>> = [
            {},
            { killSwitch: { shouldHaltDispatch: async () => true } as never },
            { agentBrake: { shouldHaltForAgent: async () => ({ halted: true }) } as never },
            {
                counters: {
                    countInFlightForWork: async () => 10,
                    countInFlightForOrganization: async () => 0,
                    countInFlightForUser: async () => 0,
                },
            },
            {
                counters: {
                    countInFlightForWork: async () => 0,
                    countInFlightForOrganization: async () => 0,
                    countInFlightForUser: async () => 25,
                },
            },
        ];
        const verdicts: unknown[] = [];
        for (const over of cases) {
            const a = await installed(context(input, over));
            const b = await shipped(context(input, over));
            expect(a).toEqual(b);
            verdicts.push(a);
        }
        expect(verdicts).toEqual([
            { admitted: true },
            { admitted: false, queuedReason: QUEUED_REASON_KILL_SWITCH },
            { admitted: false, queuedReason: QUEUED_REASON_AGENT_PAUSED },
            { admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY },
            { admitted: false, queuedReason: QUEUED_REASON_CONCURRENCY },
        ]);
    });

    it('the shipped default chain itself is unchanged', () => {
        expect(DEFAULT_RUN_ADMISSION_CHAIN).toEqual([
            killSwitchAdmission,
            agentBrakeAdmission,
            workConcurrencyAdmission,
            orgConcurrencyAdmission,
            creditsAdmission,
        ]);
    });

    it('a gate built without the installer admits exactly as before', async () => {
        const { gate } = (() => {
            const runs = {
                countInFlightForWork: jest.fn(async () => 0),
                countInFlightForOrganization: jest.fn(async () => 0),
                countInFlightForUser: jest.fn(async () => 0),
            };
            return { gate: new RunDispatchGateService(runs as never) };
        })();
        // App Work, spent budget — but nothing installed the middleware: admitted.
        await expect(gate.admit({ userId: 'u-1', workId: APP })).resolves.toEqual({
            admitted: true,
        });
    });
});

describe('where the budget sits in the chain', () => {
    const spentPort = { shouldParkForWorkBudget: jest.fn(async () => true) };
    const installed = composeRunAdmission(
        withWorkBudgetAdmission(DEFAULT_RUN_ADMISSION_CHAIN, spentPort),
    );
    const input = { userId: 'u-1', workId: APP, agentId: 'a-1' };

    it('a stopped platform and a paused Agent keep their own, more precise, park reasons', async () => {
        await expect(
            installed(
                context(input, { killSwitch: { shouldHaltDispatch: async () => true } as never }),
            ),
        ).resolves.toEqual({ admitted: false, queuedReason: QUEUED_REASON_KILL_SWITCH });
        await expect(
            installed(
                context(input, {
                    agentBrake: { shouldHaltForAgent: async () => ({ halted: true }) } as never,
                }),
            ),
        ).resolves.toEqual({ admitted: false, queuedReason: QUEUED_REASON_AGENT_PAUSED });
    });

    it('a spent budget parks before any concurrency count is taken', async () => {
        const counters = {
            countInFlightForWork: jest.fn(async () => 99),
            countInFlightForOrganization: jest.fn(async () => 99),
            countInFlightForUser: jest.fn(async () => 99),
        };
        await expect(installed(context(input, { counters }))).resolves.toEqual({
            admitted: false,
            queuedReason: QUEUED_REASON_WORK_BUDGET,
        });
        expect(counters.countInFlightForWork).not.toHaveBeenCalled();
    });

    it('is inserted right after the Agent brake, and nowhere else moves', () => {
        const chain = withWorkBudgetAdmission(DEFAULT_RUN_ADMISSION_CHAIN, spentPort);
        expect(chain).toHaveLength(DEFAULT_RUN_ADMISSION_CHAIN.length + 1);
        expect(chain[0]).toBe(killSwitchAdmission);
        expect(chain[1]).toBe(agentBrakeAdmission);
        expect(chain.slice(3)).toEqual(DEFAULT_RUN_ADMISSION_CHAIN.slice(2));
    });

    it('a budget that cannot be read fails OPEN — a broken billing check never stops work', async () => {
        const broken = createWorkBudgetAdmission({
            shouldParkForWorkBudget: async () => {
                throw new Error('db down');
            },
        });
        const chain = composeRunAdmission([broken, ...DEFAULT_RUN_ADMISSION_CHAIN]);
        await expect(chain(context(input))).resolves.toEqual({ admitted: true });
    });

    it('a guard fault is not reported as a spent budget', async () => {
        const guard = { checkBudget: jest.fn(async () => Promise.reject(new Error('db down'))) };
        const service = new AppWorkBudgetService(guard as never, undefined, worksRepo() as never);
        jest.spyOn(
            (service as never as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        await expect(service.book({ workId: APP, userId: 'u-1', charge: 'run' })).rejects.toThrow(
            'db down',
        );
    });
});

describe('AppWorkBudgetAdmissionInstaller', () => {
    it('installs nothing without a gate or a budget service', () => {
        expect(() =>
            new AppWorkBudgetAdmissionInstaller(undefined, undefined).onModuleInit(),
        ).not.toThrow();
        const gate = { withAdmissionChain: jest.fn() };
        new AppWorkBudgetAdmissionInstaller(gate as never, undefined).onModuleInit();
        expect(gate.withAdmissionChain).not.toHaveBeenCalled();
    });

    it('hands the gate the default chain with the budget inserted', () => {
        const gate = { withAdmissionChain: jest.fn() };
        const { service } = realGuard();
        const installer = new AppWorkBudgetAdmissionInstaller(gate as never, service);
        jest.spyOn(
            (installer as never as { logger: { log: () => void } }).logger,
            'log',
        ).mockImplementation(() => undefined);
        installer.onModuleInit();
        expect(gate.withAdmissionChain).toHaveBeenCalledTimes(1);
        const [chain] = gate.withAdmissionChain.mock.calls[0] as [unknown[]];
        expect(chain).toHaveLength(DEFAULT_RUN_ADMISSION_CHAIN.length + 1);
    });
});
